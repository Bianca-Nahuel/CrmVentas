import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { AppDb } from './pools.js';

export type AppTx = Parameters<Parameters<AppDb['transaction']>[0]>[0];

export interface TenantContext {
  userId: string;
  tenantId: string;
  role: string;
}

interface RequestScope {
  tx: AppTx;
  context: TenantContext | null;
}

const storage = new AsyncLocalStorage<RequestScope>();

// Setea el contexto que leen las políticas RLS. SET LOCAL (is_local = true) solo vale dentro de
// la transacción: al terminar, la conexión vuelve al pool sin contexto.
// Sin userId (trabajos de la cola, que no los dispara un usuario), app.user_id queda vacío.
export async function setDbContext(tx: AppTx, ids: { userId?: string | null; tenantId?: string | null }) {
  if (ids.userId) await tx.execute(sql`SELECT set_config('app.user_id', ${ids.userId}, true)`);
  if (ids.tenantId) await tx.execute(sql`SELECT set_config('app.tenant_id', ${ids.tenantId}, true)`);
}

/**
 * UNA transacción de ventas_app con la empresa (y opcionalmente el usuario) seteados, para código que
 * corre fuera de un request HTTP: workers de la cola y scripts. Mismo SET LOCAL que el interceptor.
 */
export function withTenantTransaction<T>(
  db: AppDb,
  ids: { tenantId: string; userId?: string | null },
  fn: (tx: AppTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setDbContext(tx, ids);
    return fn(tx);
  });
}

export function runInRequestScope<T>(scope: RequestScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

// La transacción del request. Fuera de ella no se consulta (la RLS no tendría contexto).
export function currentTx(): AppTx {
  const scope = storage.getStore();
  if (!scope) throw new Error('Consulta fuera de la transacción del request');
  return scope.tx;
}

export function currentTenantContext(): TenantContext {
  const context = storage.getStore()?.context;
  if (!context) throw new Error('No hay empresa activa en este request');
  return context;
}
