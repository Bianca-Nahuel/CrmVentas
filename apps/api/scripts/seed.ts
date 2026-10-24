// Datos de prueba para desarrollo: dos empresas ficticias, un owner en cada una y un usuario en las dos.
// Usuarios y empresas pasan por la API de servidor de Better Auth (pool de ventas_auth), así las
// contraseñas se hashean igual que en un registro real y las empresas se crean como acción de sistema
// (los usuarios comunes no pueden crear empresas). Los datos de mensajería (un canal, un contacto, una
// conversación y dos mensajes por empresa) van por el pool de ventas_app con app.tenant_id, como lo
// hará el webhook. Es idempotente.
//
// Credenciales y números SOLO de desarrollo (dominio reservado .test, teléfonos ficticios). Nunca
// usar datos reales.
import { and, eq, sql } from 'drizzle-orm';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('db:seed no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { parseEnv } = await import('../src/config/env.js');
const { createAppDatabase, createAuthDatabase } = await import('../src/db/pools.js');
const { createAuth } = await import('../src/auth/auth.js');
const { memberships, tenants, users } = await import('../src/db/schema/auth.js');
const { channels, contacts, conversations, messages } = await import('../src/db/schema/messaging.js');

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

// Canal de WhatsApp (sesión de WAHA) y cliente de prueba por empresa. Números ficticios.
const MESSAGING = {
  'ceramicos-demo': {
    session: 'ceramicos-demo',
    channelPhone: '+5491100000001',
    contactWaId: '+5491100000101',
  },
  'inmobiliaria-demo': {
    session: 'inmobiliaria-demo',
    channelPhone: '+5493510000001',
    contactWaId: '+5493510000101',
  },
} as const;

const env = parseEnv();
// Segundo chequeo: NODE_ENV también puede venir del .env cargado arriba. Y aunque falte NODE_ENV,
// el seed (contraseñas públicas) solo corre contra una API y una base locales.
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (
  env.NODE_ENV === 'production' ||
  !isLocalHost(env.BETTER_AUTH_URL) ||
  !isLocalHost(env.DATABASE_URL_AUTH) ||
  !isLocalHost(env.DATABASE_URL)
) {
  console.error('db:seed solo se ejecuta en desarrollo, contra localhost.');
  process.exit(1);
}
const authDatabase = createAuthDatabase(env.DATABASE_URL_AUTH);
const appDatabase = createAppDatabase(env.DATABASE_URL);
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

// Un canal, un contacto, una conversación y dos mensajes. Si la empresa ya tiene un canal, no hace nada.
async function ensureMessaging(slug: keyof typeof MESSAGING, tenantId: string, ownerId: string) {
  const data = MESSAGING[slug];
  await appDatabase.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    const [existing] = await tx.select({ id: channels.id }).from(channels).limit(1);
    if (existing) return;

    const now = new Date();
    const [channel] = await tx
      .insert(channels)
      .values({
        tenantId,
        name: 'ventas-principal',
        phoneNumber: data.channelPhone,
        provider: 'waha',
        connectionType: 'unofficial',
        externalId: data.session,
        status: 'connected',
        defaultUserId: ownerId,
        riskAcceptedAt: now,
        riskAcceptedBy: ownerId,
      })
      .returning({ id: channels.id });
    const [contact] = await tx
      .insert(contacts)
      .values({
        tenantId,
        waId: data.contactWaId,
        profileName: 'Cliente Demo',
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning({ id: contacts.id });
    const [conversation] = await tx
      .insert(conversations)
      .values({
        tenantId,
        channelId: channel!.id,
        contactId: contact!.id,
        lastMessageAt: now,
        lastInboundAt: now,
      })
      .returning({ id: conversations.id });
    const base = {
      tenantId,
      conversationId: conversation!.id,
      channelId: channel!.id,
      type: 'text',
      sentAt: now,
    };
    await tx.insert(messages).values([
      {
        ...base,
        externalId: 'seed-in-1',
        direction: 'inbound',
        senderType: 'contact',
        body: 'Hola, quería consultar precios.',
        status: 'received',
        raw: { seed: true },
      },
      {
        ...base,
        externalId: 'seed-out-1',
        direction: 'outbound',
        senderType: 'ai',
        body: '¡Hola! ¿Qué producto te interesa?',
        status: 'sent',
        raw: { seed: true },
      },
    ]);
  });
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

  await ensureMessaging('ceramicos-demo', tenantIds.get('ceramicos-demo')!, userIds.get(USERS[0].email)!);
  await ensureMessaging(
    'inmobiliaria-demo',
    tenantIds.get('inmobiliaria-demo')!,
    userIds.get(USERS[1].email)!,
  );

  console.log(
    `Seed listo: ${tenantIds.size} empresas, ${userIds.size} usuarios, un canal con una conversación en cada empresa.`,
  );
  console.log('Usuarios de prueba (contraseña: SEED_PASSWORD en apps/api/scripts/seed.ts):');
  for (const user of USERS) console.log(`  - ${user.email}`);
} finally {
  await Promise.all([authDatabase.close(), appDatabase.close()]);
}
