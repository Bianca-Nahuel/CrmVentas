// Encola un mensaje de texto en una conversación con el servicio real (OutboundService), con todas sus
// reglas: si el contacto nunca escribió, pasó la ventana, está bloqueado o el canal no puede enviar, queda
// rechazado. Lo manda el worker de la API (npm run dev:api tiene que estar corriendo).
// Uso: npm run dev:send -- --tenant <id de la empresa> --conversation <id> --text "..."
//
// Corre como ventas_app con la empresa activa (RLS): una conversación de otra empresa no existe.
// Solo para desarrollo: no corre con NODE_ENV=production ni contra una base que no sea local.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:send no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { parseEnv } = await import('../src/config/env.js');
const { createBoss } = await import('../src/jobs/jobs.module.js');
const { createAppDatabase } = await import('../src/db/pools.js');
const { withTenantTransaction } = await import('../src/db/tenant-context.js');
const { OutboundService, ConversationNotFoundError, InvalidOutboundError } =
  await import('../src/messaging/outbound/outbound.service.js');

const USAGE = 'Uso: npm run dev:send -- --tenant <id de la empresa> --conversation <id> --text "..."';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    conversation: { type: 'string' },
    text: { type: 'string' },
  },
  strict: true,
});
const tenantId = values.tenant?.trim();
const conversationId = values.conversation?.trim();
const text = values.text;
if (!tenantId || !conversationId || !text || !UUID.test(tenantId) || !UUID.test(conversationId)) {
  console.error(USAGE);
  process.exit(1);
}

const env = parseEnv();
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (env.NODE_ENV === 'production' || !isLocalHost(env.DATABASE_URL)) {
  console.error('dev:send solo se ejecuta en desarrollo, contra una base local.');
  process.exit(1);
}

const appDatabase = createAppDatabase(env.DATABASE_URL);
const boss = createBoss(env);
boss.on('error', (error) => console.error(`pg-boss: ${error.message}`));
try {
  await boss.start();
  const service = new OutboundService(boss);
  const result = await withTenantTransaction(appDatabase.db, { tenantId }, (tx) =>
    service.enqueueText(
      { conversationId, body: text, senderType: 'app', idempotencyKey: `dev:${randomUUID()}` },
      tx,
    ),
  );
  if (result.status === 'rejected') {
    console.error(`Rechazado (${result.rejectReason}). Envío ${result.outboundId}.`);
    process.exitCode = 1;
  } else {
    console.log(`Encolado: envío ${result.outboundId}. Lo manda el worker de npm run dev:api.`);
  }
} catch (error) {
  if (error instanceof ConversationNotFoundError) {
    console.error('Esa conversación no existe en esa empresa.');
  } else if (error instanceof InvalidOutboundError) {
    console.error(error.message);
  } else {
    // Los errores de Drizzle traen la consulta con sus parámetros (el texto): solo el código.
    const failure = error as { code?: string; cause?: { code?: string } };
    console.error(`No se pudo encolar (código ${failure.cause?.code ?? failure.code ?? 'desconocido'}).`);
  }
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: false });
  await appDatabase.close();
}
