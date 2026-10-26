// Importación del catálogo desde Excel (tarea 007): vista previa, aplicar y volver atrás. Todo con la
// empresa activa (RLS): una importación nunca ve ni toca productos de otra empresa.
// - preview: lee y valida el archivo, compara con el catálogo y guarda la importación (status preview)
//   con sus filas, sin tocar los productos;
// - apply: en una transacción, con un lock por empresa, upsert de las filas válidas, los ausentes pasan a
//   active = false (nunca se borran) y los precios o el stock del Excel quedan como snapshots;
// - revert: vuelve a aplicar las filas de la importación aplicada anterior.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { CatalogConfig } from '@ventas/shared';
import { sql } from 'drizzle-orm';
import type { AppTx } from '../../db/tenant-context.js';
import { catalogImportRows, catalogImports } from '../../db/schema/catalog.js';
import { canonical, changedMoreThan } from '../decimal.js';
import {
  mappingSchema,
  normalizeRows,
  proposeMapping,
  findHeaderRow,
  type ImportMapping,
  type NormalizedProduct,
  type NormalizedRow,
} from './normalize-rows.js';
import { readXlsx, SpreadsheetError, type XlsxLimits } from './xlsx-reader.js';

export class CatalogImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogImportError';
  }
}

export interface PreviewChange {
  sku: string;
  rowNumber: number;
  change: 'new' | 'changed' | 'unchanged';
  /** Campo → [antes, después] (solo los cambiados). */
  fields: Record<string, [unknown, unknown]>;
  priceJump: boolean;
}

export interface PreviewResult {
  importId: string;
  sheetName: string;
  sheetNames: string[];
  mapping: ImportMapping;
  mappingSource: 'argument' | 'saved' | 'proposed';
  headerRow: number;
  attributeKeys: string[];
  counts: {
    rows: number;
    invalid: number;
    new: number;
    changed: number;
    unchanged: number;
    missing: number;
    priceJumps: number;
  };
  changes: PreviewChange[];
  invalid: { rowNumber: number; sku: string | null; errors: string[] }[];
  missing: string[];
}

type CurrentProduct = {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  unit: string;
  units_per_package: string | null;
  pieces_per_package: number | null;
  url: string | null;
  attributes: Record<string, unknown>;
  active: boolean;
  excel_price: string | null;
};

const COMPARED_FIELDS = [
  'name',
  'category',
  'unit',
  'units_per_package',
  'pieces_per_package',
  'url',
  'attributes',
] as const;

function stableJson(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export class CatalogImportService {
  /** Lee el archivo, valida y guarda la vista previa. No toca el catálogo. */
  async preview(
    tx: AppTx,
    input: {
      fileName: string;
      data: Uint8Array;
      mapping?: unknown;
      catalog: CatalogConfig;
      createdBy?: string | null;
      limits?: Partial<XlsxLimits>;
    },
  ): Promise<PreviewResult> {
    let mapping: ImportMapping | undefined;
    let mappingSource: PreviewResult['mappingSource'] = 'argument';
    if (input.mapping !== undefined) {
      const parsed = mappingSchema.safeParse(input.mapping);
      if (!parsed.success) {
        throw new CatalogImportError(
          'invalid_mapping',
          `El mapeo no es válido: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(raíz)'} ${issue.message}`).join('; ')}`,
        );
      }
      mapping = parsed.data;
    } else {
      const saved = await tx.execute<{ mapping: unknown }>(sql`
        SELECT mapping FROM catalog_imports ORDER BY created_at DESC LIMIT 1
      `);
      const parsed = saved.rows[0] ? mappingSchema.safeParse(saved.rows[0].mapping) : null;
      if (parsed?.success) {
        mapping = parsed.data;
        mappingSource = 'saved';
      }
    }

    // El mapeo guardado es de un archivo anterior: si su hoja o sus columnas no están en este, se propone
    // uno nuevo por los encabezados (y la vista previa lo muestra como propuesto).
    const read = (sheetName?: string) =>
      readXlsx(input.data, {
        ...(sheetName ? { sheet: sheetName } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
      });
    let sheet: ReturnType<typeof readXlsx>;
    try {
      sheet = read(mapping?.sheet);
    } catch (error) {
      if (!(
        mappingSource === 'saved' &&
        error instanceof SpreadsheetError &&
        error.code === 'sheet_not_found'
      )) {
        throw error;
      }
      mapping = undefined;
      sheet = read();
    }
    if (
      mapping &&
      mappingSource === 'saved' &&
      normalizeRows(sheet.rows.slice(0, 50), mapping, { allowedDomains: [] }).missingHeaders.length > 0
    ) {
      mapping = undefined;
    }
    if (!mapping) {
      const headerIndex = findHeaderRow(sheet.rows);
      const proposed =
        headerIndex === null
          ? null
          : proposeMapping((sheet.rows[headerIndex] ?? []).map((cell) => String(cell ?? '')));
      if (!proposed) {
        throw new CatalogImportError(
          'mapping_required',
          'No se reconocieron las columnas de código y nombre: pasá un mapeo con --mapping.',
        );
      }
      mapping = { ...proposed, header_row: headerIndex! + 1 };
      mappingSource = 'proposed';
    }

    const normalized = normalizeRows(sheet.rows, mapping, { allowedDomains: input.catalog.allowed_domains });
    if (normalized.missingHeaders.length > 0) {
      throw new CatalogImportError(
        'missing_columns',
        `Estas columnas del mapeo no están en la hoja "${sheet.name}": ${normalized.missingHeaders.join(', ')}.`,
      );
    }

    const current = await this.currentProducts(tx);
    const baseImportId = await this.currentAppliedImportId(tx);
    const changes: PreviewChange[] = [];
    const rowChanges = new Map<NormalizedRow, PreviewChange>();
    for (const row of normalized.rows) {
      if (row.status !== 'valid') continue;
      const data = row.data as NormalizedProduct;
      const existing = current.get(data.sku);
      const change = this.diff(existing, data, input.catalog.max_price_change_pct, row.rowNumber);
      changes.push(change);
      rowChanges.set(row, change);
    }
    const fileSkus = new Set(normalized.rows.map((row) => row.sku).filter((sku): sku is string => !!sku));
    const missing = [...current.values()]
      .filter((product) => product.active && !fileSkus.has(product.sku))
      .map((product) => product.sku)
      .sort();

    const counts = {
      rows: normalized.rows.length,
      invalid: normalized.rows.filter((row) => row.status === 'invalid').length,
      new: changes.filter((change) => change.change === 'new').length,
      changed: changes.filter((change) => change.change === 'changed').length,
      unchanged: changes.filter((change) => change.change === 'unchanged').length,
      missing: missing.length,
      priceJumps: changes.filter((change) => change.priceJump).length,
    };

    const [created] = await tx
      .insert(catalogImports)
      .values({
        tenantId: sql`app_tenant_id()`,
        fileName: basename(input.fileName).slice(0, 255) || 'catalogo.xlsx',
        fileSha256: createHash('sha256').update(input.data).digest('hex'),
        fileSize: input.data.byteLength,
        sheetName: sheet.name.slice(0, 100),
        mapping: { ...mapping, sheet: sheet.name, header_row: normalized.headerRow },
        status: 'preview',
        baseImportId,
        rowsTotal: counts.rows,
        rowsInvalid: counts.invalid,
        newCount: counts.new,
        changedCount: counts.changed,
        unchangedCount: counts.unchanged,
        missingCount: counts.missing,
        priceJumpCount: counts.priceJumps,
        createdBy: input.createdBy ?? null,
      })
      .returning({ id: catalogImports.id });
    const importId = created!.id;

    // De a 500 filas por INSERT.
    for (let start = 0; start < normalized.rows.length; start += 500) {
      const chunk = normalized.rows.slice(start, start + 500);
      await tx.insert(catalogImportRows).values(
        chunk.map((row) => {
          const change = rowChanges.get(row);
          return {
            tenantId: sql`app_tenant_id()`,
            importId,
            rowNumber: row.rowNumber,
            sku: row.sku,
            data: row.data,
            status: row.status,
            errors: row.errors,
            change: change?.change ?? null,
            changedFields: change ? Object.keys(change.fields) : [],
            priceJump: change?.priceJump ?? false,
          };
        }),
      );
    }

    const attributeKeys = [
      ...new Set(
        normalized.rows.flatMap((row) => Object.keys((row.data as NormalizedProduct).attributes ?? {})),
      ),
    ];
    return {
      importId,
      sheetName: sheet.name,
      sheetNames: sheet.sheetNames,
      mapping,
      mappingSource,
      headerRow: normalized.headerRow,
      attributeKeys,
      counts,
      changes,
      invalid: normalized.rows
        .filter((row) => row.status === 'invalid')
        .map((row) => ({ rowNumber: row.rowNumber, sku: row.sku, errors: row.errors })),
      missing,
    };
  }

  /** Aplica una vista previa. Falla si desde la vista previa se aplicó otra importación. */
  async apply(
    tx: AppTx,
    importId: string,
  ): Promise<{ upserted: number; deactivated: number; snapshots: number }> {
    await this.lock(tx);
    const result = await tx.execute<{ status: string; base_import_id: string | null }>(sql`
      SELECT status, base_import_id FROM catalog_imports WHERE id = ${importId} FOR UPDATE
    `);
    const target = result.rows[0];
    if (!target) throw new CatalogImportError('not_found', 'No existe esa importación.');
    if (target.status !== 'preview') {
      throw new CatalogImportError('not_preview', `La importación está en estado ${target.status}.`);
    }
    if ((await this.currentAppliedImportId(tx)) !== target.base_import_id) {
      throw new CatalogImportError(
        'stale_preview',
        'Desde esta vista previa se aplicó otra importación: volvé a generar la vista previa.',
      );
    }
    const applied = await this.applyRows(tx, importId);
    await tx.execute(
      sql`UPDATE catalog_imports SET status = 'applied', applied_at = now() WHERE id = ${importId}`,
    );
    return applied;
  }

  /** Vuelve a la importación aplicada anterior: reaplica sus filas y marca la actual como reverted. */
  async revert(tx: AppTx): Promise<{ revertedId: string; restoredId: string }> {
    await this.lock(tx);
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id FROM catalog_imports WHERE status = 'applied' ORDER BY applied_at DESC, id DESC LIMIT 2
    `);
    const [current, previous] = result.rows;
    if (!current) throw new CatalogImportError('nothing_applied', 'No hay ninguna importación aplicada.');
    if (!previous) {
      throw new CatalogImportError('no_previous', 'No hay una importación anterior a la que volver.');
    }
    await tx.execute(
      sql`UPDATE catalog_imports SET status = 'reverted', reverted_at = now() WHERE id = ${current.id}`,
    );
    await this.applyRows(tx, previous.id);
    // La anterior vuelve a ser la vigente.
    await tx.execute(sql`UPDATE catalog_imports SET applied_at = now() WHERE id = ${previous.id}`);
    return { revertedId: current.id, restoredId: previous.id };
  }

  private async applyRows(tx: AppTx, importId: string) {
    const rows = await tx.execute<{ data: NormalizedProduct; status: string; sku: string | null }>(sql`
      SELECT data, status, sku FROM catalog_import_rows WHERE import_id = ${importId} ORDER BY row_number
    `);
    const valid = rows.rows.filter((row) => row.status === 'valid').map((row) => row.data);
    // Sin ninguna fila válida, aplicar desactivaría todo el catálogo: se rechaza.
    if (valid.length === 0) {
      throw new CatalogImportError(
        'no_valid_rows',
        'La importación no tiene ninguna fila válida: no se aplica.',
      );
    }
    // Un SKU con la fila inválida no cuenta como ausente: el producto queda como estaba.
    const fileSkus = rows.rows.map((row) => row.sku).filter((sku): sku is string => !!sku);

    let upserted: { id: string; sku: string }[] = [];
    if (valid.length > 0) {
      const records = valid.map((row) => ({
        sku: row.sku,
        name: row.name,
        category: row.category,
        unit: row.unit,
        units_per_package: row.units_per_package,
        pieces_per_package: row.pieces_per_package,
        url: row.url,
        attributes: row.attributes,
      }));
      const inserted = await tx.execute<{ id: string; sku: string }>(sql`
        INSERT INTO catalog_products
          (tenant_id, sku, name, category, unit, units_per_package, pieces_per_package, url, attributes,
           active, last_import_id)
        SELECT app_tenant_id(), r.sku, r.name, r.category, r.unit, r.units_per_package, r.pieces_per_package,
               r.url, r.attributes, true, ${importId}
        FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS r(
          sku text, name text, category text, unit text, units_per_package numeric, pieces_per_package integer,
          url text, attributes jsonb)
        ON CONFLICT (tenant_id, sku) DO UPDATE SET
          name = EXCLUDED.name, category = EXCLUDED.category, unit = EXCLUDED.unit,
          units_per_package = EXCLUDED.units_per_package, pieces_per_package = EXCLUDED.pieces_per_package,
          url = EXCLUDED.url, attributes = EXCLUDED.attributes, active = true,
          last_import_id = EXCLUDED.last_import_id
        RETURNING id, sku
      `);
      upserted = inserted.rows;
    }

    const deactivated = await tx.execute(sql`
      UPDATE catalog_products SET active = false
      WHERE active AND sku NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(fileSkus)}::jsonb))
    `);

    // Precio y stock del Excel: un snapshot por producto (solo si la columna está mapeada y tiene valor).
    const idBySku = new Map(upserted.map((row) => [row.sku, row.id]));
    const snapshots = valid
      .filter((row) => row.price !== null || row.availability !== null)
      .map((row) => ({
        product_id: idBySku.get(row.sku),
        list_price: row.price,
        availability: row.availability ?? 'unknown',
        price_unit: row.unit,
        units_per_package: row.units_per_package,
        pieces_per_package: row.pieces_per_package,
      }))
      .filter((row) => row.product_id);
    if (snapshots.length > 0) {
      await tx.execute(sql`
        INSERT INTO product_snapshots
          (tenant_id, product_id, source, import_id, ok, list_price, availability, price_unit,
           units_per_package, pieces_per_package, field_sources)
        SELECT app_tenant_id(), r.product_id, 'excel', ${importId}, true, r.list_price, r.availability,
               r.price_unit, r.units_per_package, r.pieces_per_package, '{"list_price":"excel","availability":"excel"}'::jsonb
        FROM jsonb_to_recordset(${JSON.stringify(snapshots)}::jsonb) AS r(
          product_id uuid, list_price numeric, availability text, price_unit text, units_per_package numeric,
          pieces_per_package integer)
      `);
    }
    return { upserted: upserted.length, deactivated: deactivated.rowCount ?? 0, snapshots: snapshots.length };
  }

  /** Un solo apply o revert a la vez por empresa. */
  private async lock(tx: AppTx): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('catalog-import:' || app_tenant_id()::text, 0))`,
    );
  }

  private async currentAppliedImportId(tx: AppTx): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id FROM catalog_imports WHERE status = 'applied' ORDER BY applied_at DESC, id DESC LIMIT 1
    `);
    return result.rows[0]?.id ?? null;
  }

  private async currentProducts(tx: AppTx): Promise<Map<string, CurrentProduct>> {
    const result = await tx.execute<CurrentProduct>(sql`
      SELECT p.id, p.sku, p.name, p.category, p.unit, p.units_per_package::text AS units_per_package,
             p.pieces_per_package, p.url, p.attributes, p.active,
             (SELECT s.list_price::text FROM product_snapshots s
               WHERE s.product_id = p.id AND s.source = 'excel' AND s.ok
               ORDER BY s.read_at DESC LIMIT 1) AS excel_price
      FROM catalog_products p
    `);
    return new Map(result.rows.map((row) => [row.sku, row]));
  }

  private diff(
    existing: CurrentProduct | undefined,
    data: NormalizedProduct,
    maxPriceChangePct: number,
    rowNumber: number,
  ): PreviewChange {
    if (!existing) return { sku: data.sku, rowNumber, change: 'new', fields: {}, priceJump: false };
    const fields: Record<string, [unknown, unknown]> = {};
    for (const field of COMPARED_FIELDS) {
      const before = field === 'units_per_package' ? canonical(existing.units_per_package) : existing[field];
      const after = data[field];
      if (stableJson(before ?? null) !== stableJson(after ?? null))
        fields[field] = [before ?? null, after ?? null];
    }
    if (!existing.active) fields.active = [false, true];
    const previousPrice = canonical(existing.excel_price);
    let priceJump = false;
    if (data.price !== null && previousPrice !== data.price) {
      fields.price = [previousPrice, data.price];
      priceJump = previousPrice !== null && changedMoreThan(previousPrice, data.price, maxPriceChangePct);
    }
    return {
      sku: data.sku,
      rowNumber,
      change: Object.keys(fields).length > 0 ? 'changed' : 'unchanged',
      fields,
      priceJump,
    };
  }
}
