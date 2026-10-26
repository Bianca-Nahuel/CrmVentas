// Valida una configuración del agente y la inserta como versión nueva de la empresa (nunca edita una
// versión). Hasta que exista el panel (tarea 012), la config se carga así.
// Uso: npm run dev:set-config -- --tenant <id de la empresa> --file <ruta.json> [--all-channels]
//   --all-channels: completa ai.channel_ids con todos los canales de la empresa.
//
// Corre como ventas_app con la empresa activa (RLS). Solo para desarrollo: no corre con
// NODE_ENV=production ni contra una base que no sea local.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:set-config no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { parseEnv } = await import('../src/config/env.js');
const { createAppDatabase } = await import('../src/db/pools.js');
const { withTenantTransaction } = await import('../src/db/tenant-context.js');
const { channels } = await import('../src/db/schema/messaging.js');
const { InvalidTenantConfigError, TenantConfigService } =
  await import('../src/ai/config/tenant-config.service.js');

const USAGE =
  'Uso: npm run dev:set-config -- --tenant <id de la empresa> --file <ruta.json> [--all-channels]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { values } = parseArgs({
  options: { tenant: { type: 'string' }, file: { type: 'string' }, 'all-channels': { type: 'boolean' } },
  strict: true,
});
const tenantId = values.tenant?.trim();
const file = values.file?.trim();
if (!tenantId || !file || !UUID.test(tenantId)) {
  console.error(USAGE);
  process.exit(1);
}

const env = parseEnv();
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (env.NODE_ENV === 'production' || !isLocalHost(env.DATABASE_URL)) {
  console.error('dev:set-config solo se ejecuta en desarrollo, contra una base local.');
  process.exit(1);
}

let input: Record<string, unknown>;
try {
  // npm corre el script desde apps/api: la ruta relativa se toma desde donde se llamó (INIT_CWD).
  input = JSON.parse(await readFile(resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8')) as Record<
    string,
    unknown
  >;
} catch {
  console.error(`No se pudo leer ${file} como JSON.`);
  process.exit(1);
}

const appDatabase = createAppDatabase(env.DATABASE_URL);
try {
  const version = await withTenantTransaction(appDatabase.db, { tenantId }, async (tx) => {
    if (values['all-channels']) {
      const rows = await tx.select({ id: channels.id }).from(channels);
      if (rows.length === 0) throw new Error('La empresa no tiene canales (o no existe).');
      const ai = (input.ai ?? {}) as Record<string, unknown>;
      input = { ...input, ai: { ...ai, channel_ids: rows.map((row) => row.id) } };
    }
    return new TenantConfigService().insertVersion(tx, input);
  });
  console.log(`Configuración cargada: versión ${version} de la empresa ${tenantId}.`);
} catch (error) {
  if (error instanceof InvalidTenantConfigError) {
    console.error(error.message);
  } else {
    const failure = error as { code?: string; cause?: { code?: string }; message?: string };
    const code = failure.cause?.code ?? failure.code;
    console.error(code ? `No se pudo cargar (código ${code}).` : (failure.message ?? 'No se pudo cargar.'));
  }
  process.exitCode = 1;
} finally {
  await appDatabase.close();
}
