// Panel de catálogo (tarea 027): subir el Excel, mapear columnas, revisar, aplicar y volver atrás; ver los
// productos con su último precio, forzar una lectura y probar el extractor. Reutiliza CatalogImportService
// (la misma lógica que dev:import-catalog), el ProductPageReader de CatalogService (con su límite por dominio)
// y testExtractor (el mismo SafeFetcher, con todas las protecciones SSRF). Todo con la empresa activa (RLS).
// Logs: solo ids y códigos, nunca el contenido del archivo ni de las páginas.
import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { catalogConfigSchema, type CatalogConfig } from '@ventas/shared';
import { sql } from 'drizzle-orm';
import { TenantConfigService } from '../ai/config/tenant-config.service.js';
import { APP_DB, type AppDatabase } from '../db/database.module.js';
import { catalogImportFiles } from '../db/schema/catalog.js';
import { withTenantTransaction, type AppTx, type TenantContext } from '../db/tenant-context.js';
import { WindowLimiter } from '../http/window-limiter.js';
import {
  CATALOG_PRODUCTS_PAGE_SIZE,
  CATALOG_ROWS_PAGE_SIZE,
  CATALOG_SAMPLE_ROWS,
  type ExtractorTestBody,
  type ImportPreview,
  type ImportRowsQuery,
  type ProductListQuery,
} from './catalog-admin.contracts.js';
import { CatalogService } from './catalog.service.js';
import {
  CatalogImportError,
  CatalogImportService,
  type Analysis,
  type PreviewChange,
} from './import/catalog-import.service.js';
import { describeRowError, findHeaderRow, type NormalizedProduct } from './import/normalize-rows.js';
import { SpreadsheetError, type CellValue } from './import/xlsx-reader.js';
import { invalidSelectors } from './web/extract.js';
import { testExtractor } from './web/extractor-test.js';

/** El tipo de un .xlsx. Algunos navegadores mandan octet-stream: entonces deciden la extensión y los bytes. */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ACCEPTED_MIMES = new Set([XLSX_MIME, 'application/octet-stream']);
/** Firma de un zip (un .xlsx es un zip): "PK\x03\x04". */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** Firma de un documento OLE (.xls de Excel 97-2003). */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];
const MAX_CELL_SAMPLE = 200;
const MAX_MISSING_SHOWN = 50;

export interface UploadedXlsx {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

type ImportRowDb = {
  row_number: number;
  sku: string | null;
  data: Record<string, unknown>;
  status: 'valid' | 'invalid';
  errors: string[];
  change: 'new' | 'changed' | 'unchanged' | null;
  price_jump: boolean;
  total: number;
};

type SnapshotDb = {
  id: string;
  source: 'web' | 'excel';
  read_at: Date | string;
  ok: boolean;
  error_code: string | null;
  list_price: string | null;
  promo_price: string | null;
  price_no_taxes: string | null;
  currency: string;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
};

const iso = (value: Date | string) => new Date(value).toISOString();

function startsWith(data: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, index) => data[index] === byte);
}

function cellText(value: CellValue | undefined, max: number): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value.trim() : String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function shown(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Campo → [antes, después] en filas legibles; los atributos, uno por clave que cambió. */
function fieldChanges(change: PreviewChange | undefined) {
  if (!change) return [];
  return Object.entries(change.fields).flatMap(([field, [before, after]]) => {
    if (field !== 'attributes') return [{ field, before: shown(before), after: shown(after) }];
    const from = (before ?? {}) as Record<string, unknown>;
    const to = (after ?? {}) as Record<string, unknown>;
    return [...new Set([...Object.keys(from), ...Object.keys(to)])]
      .filter((key) => shown(from[key]) !== shown(to[key]))
      .sort()
      .map((key) => ({ field: `attributes.${key}`, before: shown(from[key]), after: shown(to[key]) }));
  });
}

/** Error de lectura del archivo o del mapeo → 400 con un código estable y el mensaje del importador. */
function fileError(error: unknown): never {
  if (error instanceof SpreadsheetError) {
    throw new BadRequestException({ code: 'INVALID_FILE', reason: error.code, message: error.message });
  }
  if (error instanceof CatalogImportError) {
    throw new BadRequestException({ code: 'INVALID_MAPPING', reason: error.code, message: error.message });
  }
  throw error;
}

/** Errores de aplicar o volver atrás → 404 o 409 con el código del importador en mayúsculas. */
function importError(error: unknown): never {
  if (error instanceof CatalogImportError) {
    if (error.code === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND' });
    throw new ConflictException({ code: error.code.toUpperCase() });
  }
  throw error;
}

@Injectable()
export class CatalogAdminService {
  private readonly logger = new Logger('CatalogAdmin');
  private readonly importer = new CatalogImportService();
  /** Probar el extractor: 10 por minuto por empresa. */
  private readonly extractorLimiter = new WindowLimiter(10, 60_000);
  /** "Actualizar precio": 10 por minuto por usuario (además del límite por dominio del lector). */
  private readonly refreshLimiter = new WindowLimiter(10, 60_000);
  /** Subidas: 20 por hora por usuario (cada una guarda el archivo y sus filas de vista previa). */
  private readonly uploadLimiter = new WindowLimiter(20, 60 * 60_000);

  constructor(
    @Inject(APP_DB) private readonly database: AppDatabase,
    private readonly configs: TenantConfigService,
    private readonly catalog: CatalogService,
  ) {}

  /** La sección catalog vigente. Sin ella no hay dominios contra los que validar los links. */
  private async catalogConfig(tx: AppTx): Promise<CatalogConfig> {
    const loaded = await this.configs.latest(tx);
    if (loaded.kind !== 'ok' || !loaded.config.catalog) {
      throw new ConflictException({ code: 'CATALOG_NOT_CONFIGURED' });
    }
    return loaded.config.catalog;
  }

  /**
   * Antes de abrirlo: extensión .xlsx, content-type de xlsx (u octet-stream) y la firma de un zip. El tamaño
   * ya lo cortó multer (fileSize) antes de terminar de leer el cuerpo.
   */
  checkFile(file: UploadedXlsx | undefined): void {
    if (!file || file.buffer.byteLength === 0) {
      throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'Elegí un archivo .xlsx.' });
    }
    const reject = (reason: SpreadsheetError['code']) => {
      throw new BadRequestException({
        code: 'INVALID_FILE',
        reason,
        message: new SpreadsheetError(reason).message,
      });
    };
    if (startsWith(file.buffer, OLE_MAGIC)) reject('not_xlsx_xls');
    if (!startsWith(file.buffer, ZIP_MAGIC)) {
      // Un .csv renombrado: texto plano al principio.
      const head = file.buffer.subarray(0, 512);
      const looksText = head.every((byte) => byte === 9 || byte === 10 || byte === 13 || byte >= 32);
      reject(looksText ? 'not_xlsx_csv' : 'not_xlsx');
    }
    if (!/\.xlsx$/i.test(file.originalname) || !ACCEPTED_MIMES.has(file.mimetype)) reject('not_xlsx');
  }

  /** Sube el archivo: lo guarda 24 h, arma la vista previa con el mapeo guardado o propuesto (si hay). */
  async upload(context: TenantContext, file: UploadedXlsx | undefined): Promise<ImportPreview> {
    this.checkFile(file);
    if (!this.uploadLimiter.take(context.userId)) {
      throw new HttpException({ code: 'TOO_MANY_REQUESTS' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const data = new Uint8Array(file!.buffer);
    return withTenantTransaction(
      this.database.db,
      { tenantId: context.tenantId, userId: context.userId },
      async (tx) => {
        const catalog = await this.catalogConfig(tx);
        const analysis = await this.importer.analyze(tx, { data, catalog }).catch(fileError);
        const input = { fileName: file!.originalname, data, createdBy: context.userId };
        const ready = analysis.kind === 'ready' ? analysis : null;
        const importId = await this.importer.insertImport(tx, input, analysis.sheet.name, ready);
        const [stored] = await tx
          .insert(catalogImportFiles)
          .values({ tenantId: sql`app_tenant_id()`, importId, data: Buffer.from(data) })
          .returning({ expiresAt: catalogImportFiles.expiresAt });
        if (ready) await this.importer.insertRows(tx, importId, ready);
        this.logger.log({ msg: 'catalog-upload', importId, mapping: ready?.mappingSource ?? 'none' });
        return this.toPreview(importId, input.fileName, analysis, stored!.expiresAt);
      },
    );
  }

  /** Rehace la vista previa con otro mapeo, con el archivo guardado. */
  async rePreview(tx: AppTx, importId: string, mapping: unknown): Promise<ImportPreview> {
    const found = await tx.execute<{
      file_name: string;
      status: string;
      data: Buffer | null;
      expires_at: Date | null;
    }>(sql`
      SELECT i.file_name, i.status, f.data, f.expires_at
      FROM catalog_imports i
      LEFT JOIN catalog_import_files f ON f.import_id = i.id AND f.expires_at > now()
      WHERE i.id = ${importId}
    `);
    const target = found.rows[0];
    if (!target) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (target.status !== 'preview') throw new ConflictException({ code: 'NOT_PREVIEW' });
    if (!target.data) throw new GoneException({ code: 'FILE_EXPIRED' });
    const catalog = await this.catalogConfig(tx);
    const analysis = await this.importer
      .analyze(tx, { data: new Uint8Array(target.data), mapping, catalog })
      .catch(fileError);
    // Con un mapeo explícito, analyze nunca pide uno.
    if (analysis.kind !== 'ready') throw new BadRequestException({ code: 'INVALID_MAPPING' });
    await this.importer.replacePreview(tx, importId, analysis).catch(importError);
    return this.toPreview(importId, target.file_name, analysis, target.expires_at);
  }

  private toPreview(
    importId: string,
    fileName: string,
    analysis: Analysis,
    expiresAt: Date | string | null,
  ): ImportPreview {
    const { sheet } = analysis;
    // Sin encabezados conocidos, la primera fila con algún valor: de ahí elige las columnas el usuario (y el
    // panel manda esa fila como header_row del mapeo).
    const firstFilled = sheet.rows.findIndex((row) => row.some((cell) => cell !== null && cell !== ''));
    const headerIndex =
      analysis.kind === 'ready'
        ? analysis.normalized.headerRow - 1
        : (findHeaderRow(sheet.rows) ?? (firstFilled === -1 ? null : firstFilled));
    const headerCells = headerIndex === null ? [] : (sheet.rows[headerIndex] ?? []);
    const headers = headerCells.map((cell) => cellText(cell, 100));
    const sample: string[][] = [];
    if (headerIndex !== null) {
      for (
        let index = headerIndex + 1;
        index < sheet.rows.length && sample.length < CATALOG_SAMPLE_ROWS;
        index++
      ) {
        const row = sheet.rows[index] ?? [];
        if (row.every((cell) => cell === null || cell === '')) continue;
        sample.push(headers.map((_, column) => cellText(row[column], MAX_CELL_SAMPLE)));
      }
    }
    return {
      importId,
      fileName,
      sheetName: sheet.name,
      sheetNames: sheet.sheetNames,
      headerRow: headerIndex === null ? null : headerIndex + 1,
      headers,
      sample,
      mapping: analysis.kind === 'ready' ? { columns: analysis.mapping.columns } : null,
      mappingSource: analysis.kind === 'ready' ? analysis.mappingSource : 'none',
      counts: analysis.kind === 'ready' ? analysis.counts : null,
      missing: analysis.kind === 'ready' ? analysis.missing.slice(0, MAX_MISSING_SHOWN) : [],
      fileExpiresAt: expiresAt ? iso(expiresAt) : null,
    };
  }

  async rows(tx: AppTx, importId: string, query: ImportRowsQuery) {
    const exists = await tx.execute<{ status: string }>(
      sql`SELECT status FROM catalog_imports WHERE id = ${importId}`,
    );
    if (!exists.rows[0]) throw new NotFoundException({ code: 'NOT_FOUND' });
    const filters = [
      sql`import_id = ${importId}`,
      ...(query.change ? [sql`change = ${query.change}`] : []),
      ...(query.status ? [sql`status = ${query.status}`] : []),
      ...(query.priceJump !== undefined ? [sql`price_jump = ${query.priceJump}`] : []),
    ];
    const result = await tx.execute<ImportRowDb>(sql`
      SELECT row_number, sku, data, status, errors, change, price_jump, count(*) OVER ()::int AS total
      FROM catalog_import_rows
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY row_number
      LIMIT ${CATALOG_ROWS_PAGE_SIZE} OFFSET ${(query.page - 1) * CATALOG_ROWS_PAGE_SIZE}
    `);
    const catalog = await this.catalogConfig(tx);
    // "De qué a qué": contra el catálogo actual, solo mientras está en vista previa (después ya es historia).
    const changed = result.rows.filter((row) => row.status === 'valid' && row.change === 'changed');
    const diffs =
      exists.rows[0].status === 'preview' && changed.length > 0
        ? await this.importer.diffRows(
            tx,
            changed.map((row) => ({
              rowNumber: row.row_number,
              data: row.data as unknown as NormalizedProduct,
            })),
            catalog.max_price_change_pct,
          )
        : new Map<number, PreviewChange>();
    return {
      items: result.rows.map((row) => ({
        rowNumber: row.row_number,
        sku: row.sku,
        name: typeof row.data.name === 'string' ? row.data.name : null,
        status: row.status,
        change: row.change,
        priceJump: row.price_jump,
        errors: row.errors.map((code) => describeRowError(code, catalog.allowed_domains)),
        fields: fieldChanges(diffs.get(row.row_number)),
      })),
      page: query.page,
      pageSize: CATALOG_ROWS_PAGE_SIZE,
      total: result.rows[0]?.total ?? 0,
    };
  }

  async apply(tx: AppTx, importId: string) {
    const applied = await this.importer.apply(tx, importId).catch(importError);
    this.logger.log({ msg: 'catalog-apply', importId, ...applied });
    return applied;
  }

  async revert(tx: AppTx) {
    const reverted = await this.importer.revert(tx).catch(importError);
    this.logger.log({ msg: 'catalog-revert', ...reverted });
    return reverted;
  }

  /** Historial: las aplicadas, revertidas o fallidas (las vistas previas sin aplicar no son historia). */
  async listImports(tx: AppTx) {
    const result = await tx.execute<{
      id: string;
      file_name: string;
      status: 'preview' | 'applied' | 'reverted' | 'failed';
      rows_total: number;
      rows_invalid: number;
      new_count: number;
      changed_count: number;
      unchanged_count: number;
      missing_count: number;
      price_jump_count: number;
      created_by_name: string | null;
      created_at: Date | string;
      applied_at: Date | string | null;
      reverted_at: Date | string | null;
    }>(sql`
      SELECT i.id, i.file_name, i.status, i.rows_total, i.rows_invalid, i.new_count, i.changed_count,
             i.unchanged_count, i.missing_count, i.price_jump_count, u.name AS created_by_name,
             i.created_at, i.applied_at, i.reverted_at
      FROM catalog_imports i
      LEFT JOIN users u ON u.id = i.created_by
      WHERE i.status <> 'preview'
      ORDER BY i.created_at DESC
      LIMIT 50
    `);
    const applied = await tx.execute<{ id: string }>(sql`
      SELECT id FROM catalog_imports WHERE status = 'applied' ORDER BY applied_at DESC, id DESC LIMIT 2
    `);
    const currentId = applied.rows[0]?.id ?? null;
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        fileName: row.file_name,
        status: row.status,
        current: row.id === currentId,
        counts: {
          rows: row.rows_total,
          invalid: row.rows_invalid,
          new: row.new_count,
          changed: row.changed_count,
          unchanged: row.unchanged_count,
          missing: row.missing_count,
          priceJumps: row.price_jump_count,
        },
        createdBy: row.created_by_name ? { name: row.created_by_name } : null,
        createdAt: iso(row.created_at),
        appliedAt: row.applied_at ? iso(row.applied_at) : null,
        revertedAt: row.reverted_at ? iso(row.reverted_at) : null,
      })),
      canRevert: applied.rows.length >= 2,
    };
  }

  async listProducts(tx: AppTx, query: ProductListQuery) {
    const filters = [
      ...(query.active === 'all' ? [] : [sql`p.active = ${query.active === 'true'}`]),
      ...(query.q
        ? [
            (() => {
              // Texto literal: sin comodines del usuario.
              const like = `%${query.q.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
              return sql`(catalog_unaccent(lower(p.name)) LIKE catalog_unaccent(${like}) ESCAPE '\\'
                OR lower(p.sku) LIKE ${like} ESCAPE '\\')`;
            })(),
          ]
        : []),
    ];
    const where = filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
    const result = await tx.execute<{
      sku: string;
      name: string;
      category: string | null;
      unit: string;
      url: string | null;
      active: boolean;
      list_price: string | null;
      promo_price: string | null;
      price_no_taxes: string | null;
      currency: string | null;
      read_at: Date | string | null;
      source: 'web' | 'excel' | null;
      total: number;
    }>(sql`
      SELECT p.sku, p.name, p.category, p.unit, p.url, p.active, s.list_price, s.promo_price, s.price_no_taxes,
             s.currency, s.read_at, s.source, count(*) OVER ()::int AS total
      FROM catalog_products p
      LEFT JOIN LATERAL (
        SELECT s.list_price::text AS list_price, s.promo_price::text AS promo_price,
               s.price_no_taxes::text AS price_no_taxes, s.currency, s.read_at, s.source
        FROM product_snapshots s
        WHERE s.product_id = p.id AND s.ok
        ORDER BY s.read_at DESC LIMIT 1
      ) s ON true
      ${where}
      ORDER BY p.name, p.sku
      LIMIT ${CATALOG_PRODUCTS_PAGE_SIZE} OFFSET ${(query.page - 1) * CATALOG_PRODUCTS_PAGE_SIZE}
    `);
    return {
      items: result.rows.map((row) => ({
        sku: row.sku,
        name: row.name,
        category: row.category,
        unit: row.unit as 'm2',
        url: row.url,
        active: row.active,
        price:
          row.read_at && row.source
            ? {
                listPrice: row.list_price,
                promoPrice: row.promo_price,
                priceNoTaxes: row.price_no_taxes,
                currency: row.currency ?? 'ARS',
                readAt: iso(row.read_at),
                source: row.source,
              }
            : null,
      })),
      page: query.page,
      pageSize: CATALOG_PRODUCTS_PAGE_SIZE,
      total: result.rows[0]?.total ?? 0,
    };
  }

  async product(tx: AppTx, sku: string) {
    const found = await tx.execute<{
      id: string;
      sku: string;
      name: string;
      category: string | null;
      unit: string;
      url: string | null;
      active: boolean;
      units_per_package: string | null;
      pieces_per_package: number | null;
      attributes: Record<string, unknown>;
    }>(sql`
      SELECT id, sku, name, category, unit, url, active, units_per_package::text AS units_per_package,
             pieces_per_package, attributes
      FROM catalog_products WHERE sku = ${sku}
    `);
    const product = found.rows[0];
    if (!product) throw new NotFoundException({ code: 'NOT_FOUND' });
    const snapshots = await tx.execute<SnapshotDb>(sql`
      SELECT id, source, read_at, ok, error_code, list_price::text AS list_price, promo_price::text AS promo_price,
             price_no_taxes::text AS price_no_taxes, currency, availability
      FROM product_snapshots WHERE product_id = ${product.id}
      ORDER BY read_at DESC LIMIT 10
    `);
    const items = snapshots.rows.map((row) => ({
      id: row.id,
      source: row.source,
      readAt: iso(row.read_at),
      ok: row.ok,
      errorCode: row.error_code,
      listPrice: row.list_price,
      promoPrice: row.promo_price,
      priceNoTaxes: row.price_no_taxes,
      currency: row.currency,
      availability: row.availability,
    }));
    const latestOk = items.find((item) => item.ok);
    return {
      sku: product.sku,
      name: product.name,
      category: product.category,
      unit: product.unit as 'm2',
      url: product.url,
      active: product.active,
      price: latestOk
        ? {
            listPrice: latestOk.listPrice,
            promoPrice: latestOk.promoPrice,
            priceNoTaxes: latestOk.priceNoTaxes,
            currency: latestOk.currency,
            readAt: latestOk.readAt,
            source: latestOk.source,
          }
        : null,
      unitsPerPackage: product.units_per_package,
      piecesPerPackage: product.pieces_per_package,
      attributes: Object.entries(product.attributes)
        .map(([key, value]) => ({ key, value: shown(value) ?? '' }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      snapshots: items,
    };
  }

  /** Lee la página ahora (force), con el lector de siempre. Fuera de la transacción del request (hasta 8 s). */
  async refresh(context: TenantContext, sku: string) {
    if (!this.refreshLimiter.take(context.userId)) {
      throw new HttpException({ code: 'TOO_MANY_REQUESTS' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const ids = { tenantId: context.tenantId, userId: context.userId };
    const catalog = await withTenantTransaction(this.database.db, ids, (tx) => this.catalogConfig(tx));
    const store = this.catalog.store(context.tenantId);
    const product = await store.findProduct(sku);
    if (!product) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (!product.url) throw new ConflictException({ code: 'NO_URL' });
    const read = await this.catalog.reader.read(store, catalog, product, { force: true });
    return {
      fetched: read.fetched,
      errorCode: read.errorCode,
      product: await withTenantTransaction(this.database.db, ids, (tx) => this.product(tx, sku)),
    };
  }

  /**
   * Prueba el extractor vigente o uno en edición contra una URL. Un pedido, con las protecciones del lector
   * (https, IP pública). Nunca devuelve el HTML. Los dominios son siempre los GUARDADOS: del borrador solo se
   * toman las reglas, así el probador no lee sitios que la empresa no configuró. Solo si todavía no hay una
   * sección catalog guardada (la primera configuración) valen los del borrador (decisión #117).
   */
  async testExtractor(context: TenantContext, body: ExtractorTestBody) {
    const saved = await withTenantTransaction(
      this.database.db,
      { tenantId: context.tenantId, userId: context.userId },
      (tx) => this.catalogConfig(tx).catch(() => null),
    );
    let catalog: CatalogConfig;
    if (body.catalog !== undefined) {
      const parsed = catalogConfigSchema.safeParse(body.catalog);
      if (!parsed.success) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          issues: parsed.error.issues.map((issue) => ({
            path: ['catalog', ...issue.path].join('.'),
            code: issue.code,
            message: issue.message,
          })),
        });
      }
      catalog = saved ? { ...parsed.data, allowed_domains: saved.allowed_domains } : parsed.data;
    } else {
      if (!saved) throw new ConflictException({ code: 'CATALOG_NOT_CONFIGURED' });
      catalog = saved;
    }
    const badSelectors = invalidSelectors(catalog.extractor);
    if (badSelectors.length > 0) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        issues: badSelectors.map((field) => ({
          path: `catalog.extractor.fields.${field}.selector`,
          code: 'invalid_selector',
          message: 'selector CSS inválido',
        })),
      });
    }
    if (!this.extractorLimiter.take(context.tenantId)) {
      throw new HttpException({ code: 'TOO_MANY_REQUESTS' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const result = await testExtractor(this.catalog.fetcher, body.url, catalog);
    this.logger.log({
      msg: 'extractor-test',
      tenantId: context.tenantId,
      ok: result.ok,
      code: result.ok ? null : result.errorCode,
    });
    if (!result.ok) {
      return {
        ok: false,
        errorCode: result.errorCode,
        httpStatus: result.httpStatus,
        finalUrl: null,
        title: null,
        fields: [],
        ruleIssues: [],
        sanity: { ok: false, errorCode: null, dropped: [] },
        noAvailability: false,
      };
    }
    return { ...result, errorCode: null };
  }
}
