// Calcula conversation_metrics de las conversaciones que ya existían antes de la tarea 026 (o recalcula
// todas). Idempotente: refreshConversationMetrics recalcula desde los mensajes.
// Uso: npm run dev:backfill-metrics [-- --tenant <id de la empresa>]
//
// Corre como ventas_app con la empresa activa (RLS). Solo para desarrollo: no corre con
// NODE_ENV=production ni contra una base que no sea local. La atribución "un solo vendedor" se calcula con
// la asignación de hoy (no hay historial de asignaciones).
import { parseArgs } from 'node:util';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:backfill-metrics no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { sql } = await import('drizzle-orm');
const { parseEnv } = await import('../src/config/env.js');
const { createAppDatabase } = await import('../src/db/pools.js');
const { withTenantTransaction } = await import('../src/db/tenant-context.js');
const { refreshConversationMetrics } = await import('../src/performance/conversation-metrics.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 200;

const { values } = parseArgs({ options: { tenant: { type: 'string' } }, strict: true });
const only = values.tenant?.trim();
if (only !== undefined && !UUID.test(only)) {
  console.error('Uso: npm run dev:backfill-metrics [-- --tenant <id de la empresa>]');
  process.exit(1);
}

const env = parseEnv();
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (env.NODE_ENV === 'production' || !isLocalHost(env.DATABASE_URL)) {
  console.error('dev:backfill-metrics solo se ejecuta en desarrollo, contra una base local.');
  process.exit(1);
}

const appDatabase = createAppDatabase(env.DATABASE_URL);
try {
  const tenants = only
    ? [only]
    : (await appDatabase.db.execute<{ id: string }>(sql`SELECT id FROM active_tenant_ids() AS id`)).rows.map(
        (row) => row.id,
      );
  let total = 0;
  for (const tenantId of tenants) {
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const done = await withTenantTransaction(appDatabase.db, { tenantId }, async (tx) => {
        const ids = await tx.execute<{ id: string }>(sql`
          SELECT id FROM conversations WHERE id > ${after} ORDER BY id LIMIT ${BATCH}
        `);
        for (const row of ids.rows) await refreshConversationMetrics(tx, row.id);
        return ids.rows.map((row) => row.id);
      });
      total += done.length;
      if (done.length < BATCH) break;
      after = done.at(-1)!;
    }
  }
  console.log(`Listo: ${total} conversaciones en ${tenants.length} empresa(s).`);
} finally {
  await appDatabase.close();
}
