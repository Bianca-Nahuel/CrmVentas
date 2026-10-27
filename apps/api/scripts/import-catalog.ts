// Importa el catálogo de una empresa desde un Excel (tarea 007). Hasta que exista el panel (tarea 012),
// se importa así.
// Uso:
//   npm run dev:import-catalog -- --tenant <id> --file <ruta.xlsx> [--mapping <ruta.json>]   vista previa
//   npm run dev:import-catalog -- --tenant <id> --apply <importId>                          aplicar
//   npm run dev:import-catalog -- --tenant <id> --revert                                    volver atrás
// La vista previa no cambia el catálogo: guarda la importación y muestra nuevos, cambiados (qué cambió),
// sin cambios, ausentes, saltos de precio y filas inválidas con su motivo. El mapeo usado queda guardado y
// se reusa la próxima vez si no se pasa --mapping.
//
// Corre como ventas_app con la empresa activa (RLS). Solo para desarrollo, contra una base local.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:import-catalog no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { catalogConfigWarnings } = await import('@ventas/shared');
const { parseEnv } = await import('../src/config/env.js');
const { createAppDatabase } = await import('../src/db/pools.js');
const { withTenantTransaction } = await import('../src/db/tenant-context.js');
const { TenantConfigService } = await import('../src/ai/config/tenant-config.service.js');
const { CatalogImportError, CatalogImportService } =
  await import('../src/catalog/import/catalog-import.service.js');
const { describeRowError } = await import('../src/catalog/import/normalize-rows.js');
const { SpreadsheetError } = await import('../src/catalog/import/xlsx-reader.js');

const USAGE = `Uso:
  npm run dev:import-catalog -- --tenant <id> --file <ruta.xlsx> [--mapping <ruta.json>]
  npm run dev:import-catalog -- --tenant <id> --apply <importId>
  npm run dev:import-catalog -- --tenant <id> --revert`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LISTED = 30;

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    file: { type: 'string' },
    mapping: { type: 'string' },
    apply: { type: 'string' },
    revert: { type: 'boolean' },
  },
  strict: true,
});
const tenantId = values.tenant?.trim();
const modes = [values.file, values.apply, values.revert].filter(Boolean).length;
if (!tenantId || !UUID.test(tenantId) || modes !== 1 || (values.apply && !UUID.test(values.apply))) {
  console.error(USAGE);
  process.exit(1);
}

const env = parseEnv();
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (!isLocalHost(env.DATABASE_URL)) {
  console.error('dev:import-catalog solo se ejecuta en desarrollo, contra una base local.');
  process.exit(1);
}
// npm corre el script desde apps/api: las rutas relativas se toman desde donde se llamó (INIT_CWD).
const fromCaller = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

const appDatabase = createAppDatabase(env.DATABASE_URL);
const importer = new CatalogImportService();
const configs = new TenantConfigService();
const show = (value: unknown) => (value === null || value === undefined ? '—' : JSON.stringify(value));

try {
  await withTenantTransaction(appDatabase.db, { tenantId }, async (tx) => {
    const loaded = await configs.latest(tx);
    if (loaded.kind !== 'ok' || !loaded.config.catalog) {
      throw new CatalogImportError(
        'no_catalog',
        'La empresa no tiene una config con la sección catalog (dev:set-config).',
      );
    }
    const catalog = loaded.config.catalog;
    for (const warning of catalogConfigWarnings(catalog)) console.warn(`Aviso: ${warning}`);

    if (values.revert) {
      const result = await importer.revert(tx);
      console.log(
        `Listo: se volvió a la importación ${result.restoredId} (la ${result.revertedId} quedó reverted).`,
      );
      return;
    }
    if (values.apply) {
      const result = await importer.apply(tx, values.apply);
      console.log(
        `Aplicada: ${result.upserted} productos cargados o actualizados, ${result.deactivated} desactivados, ${result.snapshots} precios o stock del Excel.`,
      );
      return;
    }

    const mapping = values.mapping
      ? JSON.parse(await readFile(fromCaller(values.mapping), 'utf8'))
      : undefined;
    const data = await readFile(fromCaller(values.file!));
    const preview = await importer.preview(tx, { fileName: values.file!, data, mapping, catalog });
    const { counts } = preview;
    console.log(
      `Hoja "${preview.sheetName}" (de ${preview.sheetNames.join(', ')}), encabezados en la fila ${preview.headerRow}.`,
    );
    console.log(
      `Mapeo (${preview.mappingSource === 'argument' ? 'del archivo --mapping' : preview.mappingSource === 'saved' ? 'guardado de la importación anterior' : 'propuesto por los encabezados: revisalo'}):`,
    );
    for (const [field, header] of Object.entries(preview.mapping.columns))
      if (header) console.log(`  ${field} ← "${header}"`);
    console.log(`  attributes ← ${preview.attributeKeys.join(', ') || '(ninguna columna extra)'}`);
    console.log(
      `\nFilas: ${counts.rows} · nuevos ${counts.new} · cambiados ${counts.changed} · sin cambios ${counts.unchanged} · ausentes ${counts.missing} · inválidas ${counts.invalid} · saltos de precio ${counts.priceJumps}`,
    );
    const changed = preview.changes.filter((change) => change.change === 'changed');
    if (changed.length > 0) console.log('\nCambiados:');
    for (const change of changed.slice(0, MAX_LISTED)) {
      const fields = Object.entries(change.fields).map(
        ([field, [before, after]]) => `${field}: ${show(before)} → ${show(after)}`,
      );
      console.log(
        `  ${change.priceJump ? '⚠ ' : ''}${change.sku} (fila ${change.rowNumber}): ${fields.join('; ')}`,
      );
    }
    if (counts.priceJumps > 0)
      console.log(
        `  ⚠ = el precio cambia más de ${catalog.max_price_change_pct} %: revisalo antes de aplicar.`,
      );
    const created = preview.changes.filter((change) => change.change === 'new');
    if (created.length > 0)
      console.log(
        `\nNuevos: ${created
          .slice(0, MAX_LISTED)
          .map((change) => change.sku)
          .join(', ')}${created.length > MAX_LISTED ? '…' : ''}`,
      );
    if (preview.missing.length > 0) {
      console.log(
        `\nAusentes (se van a desactivar, no se borran): ${preview.missing.slice(0, MAX_LISTED).join(', ')}${preview.missing.length > MAX_LISTED ? '…' : ''}`,
      );
    }
    if (preview.invalid.length > 0)
      console.log('\nFilas inválidas (no se aplican; el producto queda como estaba):');
    for (const row of preview.invalid.slice(0, MAX_LISTED)) {
      console.log(
        `  fila ${row.rowNumber}${row.sku ? ` (${row.sku})` : ''}: ${row.errors.map((code) => describeRowError(code, catalog.allowed_domains)).join('; ')}`,
      );
    }
    console.log(
      `\nVista previa guardada. Para aplicarla:\n  npm run dev:import-catalog -- --tenant ${tenantId} --apply ${preview.importId}`,
    );
  });
} catch (error) {
  if (error instanceof CatalogImportError || error instanceof SpreadsheetError) {
    console.error(error.message);
  } else if (error instanceof SyntaxError) {
    console.error('El archivo de --mapping no es un JSON válido.');
  } else {
    const failure = error as { code?: string; cause?: { code?: string }; message?: string };
    const code = failure.cause?.code ?? failure.code;
    console.error(code ? `No se pudo importar (código ${code}).` : 'No se pudo importar.');
  }
  process.exitCode = 1;
} finally {
  await appDatabase.close();
}
