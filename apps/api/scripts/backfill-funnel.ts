// Completa los datos del embudo (tarea 028) en las conversaciones que ya existían: el nivel máximo
// (conversations.lead_tier_peak, desde ai_runs con los umbrales de cada versión) y la primera derivación
// (conversation_metrics.handed_off_at, desde ai_runs y los eventos ai_reactivated). Idempotente: ver
// src/funnel/funnel-backfill.ts.
// Uso: npm run dev:backfill-funnel [-- --tenant <id de la empresa>]
//
// Corre como ventas_app con la empresa activa (RLS). Solo para desarrollo: no corre con
// NODE_ENV=production ni contra una base que no sea local. Solo ids y contadores en la salida.
import { parseArgs } from 'node:util';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:backfill-funnel no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { sql } = await import('drizzle-orm');
const { parseEnv } = await import('../src/config/env.js');
const { createAppDatabase } = await import('../src/db/pools.js');
const { withTenantTransaction } = await import('../src/db/tenant-context.js');
const { backfillFunnelConversation } = await import('../src/funnel/funnel-backfill.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 200;

const { values } = parseArgs({ options: { tenant: { type: 'string' } }, strict: true });
const only = values.tenant?.trim();
if (only !== undefined && !UUID.test(only)) {
  console.error('Uso: npm run dev:backfill-funnel [-- --tenant <id de la empresa>]');
  process.exit(1);
}

const env = parseEnv();
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (env.NODE_ENV === 'production' || !isLocalHost(env.DATABASE_URL)) {
  console.error('dev:backfill-funnel solo se ejecuta en desarrollo, contra una base local.');
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
  let tiers = 0;
  let handoffs = 0;
  for (const tenantId of tenants) {
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const done = await withTenantTransaction(appDatabase.db, { tenantId }, async (tx) => {
        const ids = await tx.execute<{ id: string }>(sql`
          SELECT id FROM conversations WHERE id > ${after} ORDER BY id LIMIT ${BATCH}
        `);
        for (const row of ids.rows) {
          const result = await backfillFunnelConversation(tx, row.id);
          if (result.tierFilled) tiers++;
          if (result.handoffMoved) handoffs++;
        }
        return ids.rows.map((row) => row.id);
      });
      total += done.length;
      if (done.length < BATCH) break;
      after = done.at(-1)!;
    }
  }
  console.log(
    `Listo: ${total} conversaciones en ${tenants.length} empresa(s); nivel máximo completado en ${tiers}, primera derivación corregida en ${handoffs}.`,
  );
} finally {
  await appDatabase.close();
}
