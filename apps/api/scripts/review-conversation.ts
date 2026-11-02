// Corre el analista de calidad (tarea 026) sobre una conversación, con el modelo real (OpenRouter). Respeta
// review.enabled, el tope diario y la regla de "una vez por último mensaje", igual que el trabajo diario.
// Uso: npm run dev:review -- --conversation <id> [--tenant <id de la empresa>]
//
// Solo para desarrollo (base local). Muestra el resultado y el costo; la revisión se ve en el panel
// (Rendimiento → Revisiones). No imprime el texto de los mensajes.
import { parseArgs } from 'node:util';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:review no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { sql } = await import('drizzle-orm');
const { parseEnv } = await import('../src/config/env.js');
const { createAppDatabase } = await import('../src/db/pools.js');
const { withTenantTransaction } = await import('../src/db/tenant-context.js');
const { TenantConfigService } = await import('../src/ai/config/tenant-config.service.js');
const { NoopBudgetGuard } = await import('../src/ai/llm/budget-guard.js');
const { PlatformLlmClientFactory } = await import('../src/ai/llm/llm-client.factory.js');
const { ReviewService } = await import('../src/performance/review/review.service.js');

const USAGE = 'Uso: npm run dev:review -- --conversation <id> [--tenant <id de la empresa>]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { values } = parseArgs({
  options: { conversation: { type: 'string' }, tenant: { type: 'string' } },
  strict: true,
});
const conversationId = values.conversation?.trim();
if (!conversationId || !UUID.test(conversationId) || (values.tenant && !UUID.test(values.tenant))) {
  console.error(USAGE);
  process.exit(1);
}

const env = parseEnv();
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (env.NODE_ENV === 'production' || !isLocalHost(env.DATABASE_URL)) {
  console.error('dev:review solo se ejecuta en desarrollo, contra una base local.');
  process.exit(1);
}

const appDatabase = createAppDatabase(env.DATABASE_URL);
try {
  // Sin --tenant: la empresa de la conversación (se prueba con cada empresa activa; la RLS esconde el resto).
  let tenantId = values.tenant ?? null;
  if (!tenantId) {
    const tenants = await appDatabase.db.execute<{ id: string }>(
      sql`SELECT id FROM active_tenant_ids() AS id`,
    );
    for (const { id } of tenants.rows) {
      const found = await withTenantTransaction(appDatabase.db, { tenantId: id }, (tx) =>
        tx.execute(sql`SELECT 1 FROM conversations WHERE id = ${conversationId}`),
      );
      if (found.rows.length > 0) {
        tenantId = id;
        break;
      }
    }
  }
  if (!tenantId) {
    console.error('No se encontró la conversación en ninguna empresa activa.');
    process.exit(1);
  }
  const service = new ReviewService(
    env,
    appDatabase,
    new PlatformLlmClientFactory(env),
    new NoopBudgetGuard(),
    new TenantConfigService(),
  );
  const result = await service.reviewConversation(tenantId, conversationId);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'skipped' && result.reason === 'disabled')
    console.log(
      'La revisión está apagada: AI_ENABLED=false o review.enabled = false en la config de la empresa.',
    );
} finally {
  await appDatabase.close();
}
