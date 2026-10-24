// Levanta la pausa de envíos de un canal (la pone el worker ante un riesgo de bloqueo: errores 463/475 de
// WAHA, sin vencimiento). No toca la sesión de WAHA. Antes de levantarla, bajá el ritmo de envíos.
// Uso: npm run dev:resume-channel -- --tenant <id de la empresa> --channel <id del canal>
//
// Corre como ventas_app con la empresa activa (RLS): un canal de otra empresa no existe.
// Solo para desarrollo: no corre con NODE_ENV=production ni contra una base que no sea local.
import { parseArgs } from 'node:util';
import { eq, isNotNull, and } from 'drizzle-orm';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:resume-channel no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { parseEnv } = await import('../src/config/env.js');
const { createAppDatabase } = await import('../src/db/pools.js');
const { withTenantTransaction } = await import('../src/db/tenant-context.js');
const { channels } = await import('../src/db/schema/messaging.js');

const USAGE = 'Uso: npm run dev:resume-channel -- --tenant <id de la empresa> --channel <id del canal>';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { values } = parseArgs({
  options: { tenant: { type: 'string' }, channel: { type: 'string' } },
  strict: true,
});
const tenantId = values.tenant?.trim();
const channelId = values.channel?.trim();
if (!tenantId || !channelId || !UUID.test(tenantId) || !UUID.test(channelId)) {
  console.error(USAGE);
  process.exit(1);
}

const env = parseEnv();
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (env.NODE_ENV === 'production' || !isLocalHost(env.DATABASE_URL)) {
  console.error('dev:resume-channel solo se ejecuta en desarrollo, contra una base local.');
  process.exit(1);
}

const appDatabase = createAppDatabase(env.DATABASE_URL);
try {
  const resumed = await withTenantTransaction(appDatabase.db, { tenantId }, (tx) =>
    tx
      .update(channels)
      .set({ sendingPausedUntil: null, sendingPausedReason: null })
      .where(and(eq(channels.id, channelId), isNotNull(channels.sendingPausedUntil)))
      .returning({ id: channels.id }),
  );
  if (resumed.length === 0) {
    console.error('No hay un canal pausado con ese id en esa empresa.');
    process.exitCode = 1;
  } else {
    console.log(`Envíos reanudados en el canal ${channelId}.`);
  }
} catch (error) {
  const failure = error as { code?: string; cause?: { code?: string } };
  console.error(`No se pudo reanudar (código ${failure.cause?.code ?? failure.code ?? 'desconocido'}).`);
  process.exitCode = 1;
} finally {
  await appDatabase.close();
}
