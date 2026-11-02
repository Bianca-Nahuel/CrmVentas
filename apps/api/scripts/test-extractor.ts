// Prueba el extractor de una empresa contra la página de un producto (tarea 007): muestra cada campo, de
// dónde salió (jsonld, microdata, meta o extractor), lo que encontró cada regla y si pasa los controles de
// cordura. Sirve para configurar el extractor de una empresa nueva. Hace UN pedido por corrida, con las
// mismas protecciones que producción (solo allowed_domains de la empresa, IP pública, 2 MB, 8 s). No guarda
// nada en la base ni muestra el HTML.
// Uso: npm run dev:test-extractor -- --tenant <id> --url <url> [--config <ruta.json>]
//   --config: probar una config (o solo su sección catalog) antes de cargarla con dev:set-config.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:test-extractor no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { catalogConfigSchema, catalogConfigWarnings } = await import('@ventas/shared');
const { parseEnv } = await import('../src/config/env.js');
const { createAppDatabase } = await import('../src/db/pools.js');
const { withTenantTransaction } = await import('../src/db/tenant-context.js');
const { TenantConfigService } = await import('../src/ai/config/tenant-config.service.js');
const { CATALOG_USER_AGENT } = await import('../src/catalog/catalog.service.js');
const { SafeFetcher } = await import('../src/catalog/web/safe-fetch.js');
const { invalidSelectors } = await import('../src/catalog/web/extract.js');
const { testExtractor } = await import('../src/catalog/web/extractor-test.js');

const USAGE = 'Uso: npm run dev:test-extractor -- --tenant <id> --url <url> [--config <ruta.json>]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { values } = parseArgs({
  options: { tenant: { type: 'string' }, url: { type: 'string' }, config: { type: 'string' } },
  strict: true,
});
const tenantId = values.tenant?.trim();
const url = values.url?.trim();
if (!tenantId || !UUID.test(tenantId) || !url) {
  console.error(USAGE);
  process.exit(1);
}

const env = parseEnv();
let catalog;
if (values.config) {
  const raw = JSON.parse(
    await readFile(resolve(process.env.INIT_CWD ?? process.cwd(), values.config), 'utf8'),
  ) as {
    catalog?: unknown;
  };
  const parsed = catalogConfigSchema.safeParse(raw.catalog ?? raw);
  if (!parsed.success) {
    console.error(
      parsed.error.issues.map((issue) => `- catalog.${issue.path.join('.')}: ${issue.message}`).join('\n'),
    );
    process.exit(1);
  }
  catalog = parsed.data;
} else {
  const appDatabase = createAppDatabase(env.DATABASE_URL);
  try {
    const loaded = await withTenantTransaction(appDatabase.db, { tenantId }, (tx) =>
      new TenantConfigService().latest(tx),
    );
    catalog = loaded.kind === 'ok' ? loaded.config.catalog : undefined;
  } finally {
    await appDatabase.close();
  }
  if (!catalog) {
    console.error(
      'La empresa no tiene la sección catalog en su config (o no tiene config). Probá con --config.',
    );
    process.exit(1);
  }
}
for (const warning of catalogConfigWarnings(catalog)) console.warn(`Aviso: ${warning}`);
const badSelectors = invalidSelectors(catalog.extractor);
if (badSelectors.length > 0) {
  console.error(`Selectores CSS inválidos en: ${badSelectors.join(', ')}`);
  process.exit(1);
}

const result = await testExtractor(new SafeFetcher({ userAgent: CATALOG_USER_AGENT }), url, catalog);
if (!result.ok) {
  console.error(
    `No se leyó la página: ${result.errorCode}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}.`,
  );
  process.exit(1);
}
console.log(`Leída: ${result.finalUrl} (HTTP ${result.httpStatus})\n`);
if (result.title) console.log(`Título (h1): ${result.title}\n`);
const width = 18;
for (const { field, value, source, matched } of result.fields) {
  const shown = value === null ? '—' : value.slice(0, 120);
  console.log(
    `${field.padEnd(width)} ${shown}${source ? `   [${source}]` : ''}${matched ? `   (texto: "${matched.slice(0, 60)}")` : ''}`,
  );
}
if (result.ruleIssues.length > 0) {
  console.log('\nReglas del extractor que no dieron un valor:');
  for (const issue of result.ruleIssues) console.log(`  - ${issue}`);
}
console.log(
  `\nControles de cordura: ${result.sanity.ok ? 'OK' : `FALLA (${result.sanity.errorCode})`}${result.sanity.dropped.length > 0 ? `; descartados: ${result.sanity.dropped.join(', ')}` : ''}`,
);
if (result.noAvailability) {
  console.log(
    'Aviso: availability_source es web pero la página no informa disponibilidad: el agente va a derivar.',
  );
}
