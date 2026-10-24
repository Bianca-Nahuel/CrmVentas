// Reaplica la configuración del webhook (URL, eventos y clave HMAC del .env) a la sesión de WAHA de un
// canal existente, sin volver a escanear el QR. Sirve si la sesión se creó con otra WAHA_WEBHOOK_URL o
// si se cambió WAHA_WEBHOOK_HMAC_KEY.
// Uso: npm run dev:sync-channel-webhook -- --session ch_<id>
//
// Solo actúa sobre sesiones que pertenecen a un canal registrado (resolve_channel). WAHA reinicia la
// sesión con la configuración nueva; la vinculación con el teléfono se conserva.
// Solo para desarrollo: no corre con NODE_ENV=production ni contra una base que no sea local.
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:sync-channel-webhook no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { parseEnv } = await import('../src/config/env.js');
const { createAppDatabase } = await import('../src/db/pools.js');
const { WahaClient } = await import('../src/whatsapp/providers/waha/waha-client.js');
const { CHANNEL_SESSION_NAME, wahaSessionFor } = await import('./lib/waha-session.js');

const { values } = parseArgs({ options: { session: { type: 'string' } }, strict: true });
const session = values.session?.trim();
if (!session || !CHANNEL_SESSION_NAME.test(session)) {
  console.error('Uso: npm run dev:sync-channel-webhook -- --session ch_<id del canal sin guiones>');
  process.exit(1);
}

const env = parseEnv();
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (env.NODE_ENV === 'production' || !isLocalHost(env.DATABASE_URL)) {
  console.error('dev:sync-channel-webhook solo se ejecuta en desarrollo, contra una base local.');
  process.exit(1);
}

const appDatabase = createAppDatabase(env.DATABASE_URL);
try {
  const result = await appDatabase.db.execute<{ channel_id: string }>(
    sql`SELECT channel_id FROM resolve_channel('waha', ${session})`,
  );
  if (result.rows.length === 0) {
    console.error('No hay un canal de WAHA activo con esa sesión.');
    process.exitCode = 1;
  } else {
    await new WahaClient(env.WAHA_BASE_URL, env.WAHA_API_KEY).updateSession(wahaSessionFor(env, session));
    console.log(`Webhook actualizado en la sesión ${session}. WAHA la reinicia; no hace falta escanear.`);
  }
} catch (error) {
  const failure = error as { message?: string; code?: string; cause?: { code?: string } };
  if (failure.message?.startsWith('WAHA respondió')) {
    console.error(`No se pudo actualizar: ${failure.message}`);
  } else {
    console.error(`No se pudo actualizar (código ${failure.cause?.code ?? failure.code ?? 'desconocido'}).`);
  }
  process.exitCode = 1;
} finally {
  await appDatabase.close();
}
