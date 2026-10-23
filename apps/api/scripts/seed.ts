// Datos de prueba para desarrollo: dos empresas ficticias, un owner en cada una y un usuario en las dos.
// Todo pasa por la API de servidor de Better Auth (pool de ventas_auth), así las contraseñas se
// hashean igual que en un registro real y las empresas se crean como acción de sistema
// (los usuarios comunes no pueden crear empresas). Es idempotente.
//
// Credenciales SOLO de desarrollo (dominio reservado .test). Nunca usar datos reales.
import { and, eq } from 'drizzle-orm';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('db:seed no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { parseEnv } = await import('../src/config/env.js');
const { createAuthDatabase } = await import('../src/db/pools.js');
const { createAuth } = await import('../src/auth/auth.js');
const { memberships, tenants, users } = await import('../src/db/schema/auth.js');

export const SEED_PASSWORD = 'dev-only-Password-123';

const TENANTS = [
  {
    slug: 'ceramicos-demo',
    name: 'Cerámicos Demo',
    industry: 'ceramics',
    timezone: 'America/Argentina/Buenos_Aires',
  },
  {
    slug: 'inmobiliaria-demo',
    name: 'Inmobiliaria Demo',
    industry: 'real_estate',
    timezone: 'America/Argentina/Cordoba',
  },
] as const;

const USERS = [
  { email: 'owner.ceramicos@example.test', name: 'Owner Cerámicos' },
  { email: 'owner.inmobiliaria@example.test', name: 'Owner Inmobiliaria' },
  { email: 'multi@example.test', name: 'Usuario Dos Empresas' },
] as const;

// [email, slug, rol]. El owner de cada empresa queda como owner al crearla.
const EXTRA_MEMBERSHIPS = [
  ['multi@example.test', 'ceramicos-demo', 'seller'],
  ['multi@example.test', 'inmobiliaria-demo', 'viewer'],
] as const;

const env = parseEnv();
// Segundo chequeo: NODE_ENV también puede venir del .env cargado arriba. Y aunque falte NODE_ENV,
// el seed (contraseñas públicas) solo corre contra una API y una base locales.
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (
  env.NODE_ENV === 'production' ||
  !isLocalHost(env.BETTER_AUTH_URL) ||
  !isLocalHost(env.DATABASE_URL_AUTH)
) {
  console.error('db:seed solo se ejecuta en desarrollo, contra localhost.');
  process.exit(1);
}
const authDatabase = createAuthDatabase(env.DATABASE_URL_AUTH);
const auth = createAuth(env, authDatabase.db);
const db = authDatabase.db;

async function ensureUser(email: string, name: string): Promise<string> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) return existing.id;
  const result = await auth.api.signUpEmail({ body: { email, name, password: SEED_PASSWORD } });
  return result.user.id;
}

async function ensureTenant(tenant: (typeof TENANTS)[number], ownerId: string): Promise<string> {
  const [existing] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, tenant.slug));
  if (existing) return existing.id;
  const created = await auth.api.createOrganization({ body: { ...tenant, userId: ownerId } });
  if (!created) throw new Error(`No se pudo crear la empresa ${tenant.slug}`);
  return created.id;
}

try {
  const userIds = new Map<string, string>();
  for (const user of USERS) userIds.set(user.email, await ensureUser(user.email, user.name));

  const tenantIds = new Map<string, string>();
  tenantIds.set('ceramicos-demo', await ensureTenant(TENANTS[0], userIds.get(USERS[0].email)!));
  tenantIds.set('inmobiliaria-demo', await ensureTenant(TENANTS[1], userIds.get(USERS[1].email)!));

  for (const [email, slug, role] of EXTRA_MEMBERSHIPS) {
    const userId = userIds.get(email)!;
    const tenantId = tenantIds.get(slug)!;
    const [existing] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)));
    if (!existing) await auth.api.addMember({ body: { userId, organizationId: tenantId, role } });
  }

  console.log(`Seed listo: ${tenantIds.size} empresas, ${userIds.size} usuarios.`);
  console.log('Usuarios de prueba (contraseña: SEED_PASSWORD en apps/api/scripts/seed.ts):');
  for (const user of USERS) console.log(`  - ${user.email}`);
} finally {
  await authDatabase.close();
}
