import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { authSchema } from './schema/auth.js';
import { messagingSchema } from './schema/messaging.js';

const appSchema = { ...authSchema, ...messagingSchema };

export type AppDb = NodePgDatabase<typeof appSchema>;
export type AuthDb = NodePgDatabase<typeof authSchema>;

export interface Database<TDb> {
  pool: pg.Pool;
  db: TDb;
  close(): Promise<void>;
}

// Dos pools separados a propósito (ver docs/specs/autenticacion.md, "Usuarios de base y RLS"):
// - app  → DATABASE_URL      (ventas_app): todo el código de negocio, siempre con RLS.
// - auth → DATABASE_URL_AUTH (ventas_auth): solo Better Auth; sin acceso a tablas de negocio.
// En Nest, el de auth solo se provee dentro de AppAuthModule (AuthDatabaseModule); el resto del
// código no puede inyectarlo.
export function createAppDatabase(url: string): Database<AppDb> {
  const pool = new pg.Pool({ connectionString: url, application_name: 'ventas-api' });
  return { pool, db: drizzle(pool, { schema: appSchema }), close: () => pool.end() };
}

export function createAuthDatabase(url: string): Database<AuthDb> {
  const pool = new pg.Pool({ connectionString: url, application_name: 'ventas-auth', max: 5 });
  return { pool, db: drizzle(pool, { schema: authSchema }), close: () => pool.end() };
}

// Si la conexión resultara ser superusuario o con BYPASSRLS (por ejemplo, DATABASE_URL apuntando por
// error al dueño), la RLS se ignoraría en silencio: mejor no arrancar.
export async function assertRestrictedRole(pool: pg.Pool, label: string): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const role = rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error(`La conexión ${label} usa un rol con superusuario o BYPASSRLS: la RLS no se aplicaría`);
  }
}
