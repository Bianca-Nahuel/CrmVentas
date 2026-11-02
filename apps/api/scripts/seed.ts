// Datos de prueba para desarrollo: dos empresas ficticias, un owner en cada una y un usuario en las dos.
// Usuarios y empresas pasan por la API de servidor de Better Auth (pool de ventas_auth), así las
// contraseñas se hashean igual que en un registro real y las empresas se crean como acción de sistema
// (los usuarios comunes no pueden crear empresas). Los datos de mensajería (un canal, un contacto, una
// conversación y dos mensajes por empresa) van por el pool de ventas_app con app.tenant_id, como lo
// hará el webhook. Cerámicos suma un segundo número, leads de demo para la bandeja y multi@ asignado al
// número principal (tarea 014), y leads para responder desde el panel con la sucursal pausada (tarea 024).
// Es idempotente.
//
// Credenciales y números SOLO de desarrollo (dominio reservado .test, teléfonos ficticios). Nunca
// usar datos reales.
import { and, eq, inArray, sql } from 'drizzle-orm';
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
const { channels, contacts, conversations, messages, outboundMessages } =
  await import('../src/db/schema/messaging.js');

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
  { email: 'baja@example.test', name: 'Usuario Dado De Baja' },
  { email: 'vendedor.sin.numeros@example.test', name: 'Vendedor Sin Números' },
] as const;

// [email, slug, rol, status]. El owner de cada empresa queda como owner al crearla.
// baja@ tiene la membresía desactivada: para probar la pantalla "sin acceso" del panel.
const EXTRA_MEMBERSHIPS = [
  ['multi@example.test', 'ceramicos-demo', 'seller', 'active'],
  ['multi@example.test', 'inmobiliaria-demo', 'viewer', 'active'],
  ['baja@example.test', 'ceramicos-demo', 'seller', 'disabled'],
  // Seller sin números asignados: para el estado vacío de la bandeja (tarea 014).
  ['vendedor.sin.numeros@example.test', 'ceramicos-demo', 'seller', 'active'],
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
  // createUser del plugin admin: el registro público está desactivado (disableSignUp).
  const result = await auth.api.createUser({ body: { email, name, password: SEED_PASSWORD } });
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

// Bandeja de Cerámicos (tarea 014): un segundo número, leads con puntajes y estados variados, y multi@
// asignado solo al número principal. Las conversaciones se crean una vez, pero el estado de cada lead
// (puntaje, derivación, pausa) se vuelve a poner en cada corrida: los e2e del panel lo cambian.
type SeedMessage = {
  from: 'contact' | 'ai' | 'user';
  text: string | null;
  type?: string;
  minutesAgo: number;
  /** Acuse de un saliente (por defecto, leído). */
  status?: 'sent' | 'delivered' | 'read';
};
interface SeedLead {
  waId: string;
  name: string;
  channel: 'principal' | 'sucursal';
  score: number | null;
  tier: 'hot' | 'warm' | 'cold' | null;
  handoff?: { reason: string; summary: string };
  pausedHours?: number;
  extracted?: Record<string, string | number>;
  messages: SeedMessage[];
  /** Respuestas del equipo que no salieron (filas failed del outbox, sin mensaje). */
  failedOutbound?: { text: string; minutesAgo: number; lastError: 'invalid_recipient' | 'unknown_outcome' }[];
}

const DAY = 24 * 60;
const SUCURSAL = { name: 'sucursal-norte', phone: '+5491100000002', session: 'ceramicos-sucursal' };
const DEMO_LEADS: SeedLead[] = [
  {
    waId: '+5491100000201',
    name: 'Ana Gómez',
    channel: 'principal',
    score: 82,
    tier: 'hot',
    handoff: {
      reason: 'asks_human',
      summary:
        'Busca porcelanato 60x60 gris para el living, unos 45 m². Quiere retirar esta semana. Falta confirmar la zona.',
    },
    extracted: { producto_ambiente: 'living', m2: 45, entrega: 'retiro' },
    messages: [
      { from: 'contact', text: 'Hola! Tienen porcelanato 60x60 gris?', minutesAgo: DAY + 50 },
      {
        from: 'ai',
        text: '¡Hola! Sí, trabajamos porcelanatos. ¿Para qué ambiente es?',
        minutesAgo: DAY + 49,
      },
      { from: 'contact', text: 'Para el living, son unos 45 m2', minutesAgo: 30 },
      { from: 'contact', text: 'Puedo hablar con alguien?', minutesAgo: 6 },
    ],
  },
  {
    waId: '+5491100000202',
    name: 'Juan Pérez',
    channel: 'principal',
    score: 64,
    tier: 'warm',
    extracted: { producto_ambiente: 'baño' },
    messages: [
      { from: 'contact', text: 'Buenas, quería ver revestimientos para el baño', minutesAgo: 3 * DAY },
      { from: 'ai', text: '¡Hola Juan! ¿Cuántos m² necesitás, más o menos?', minutesAgo: 3 * DAY - 1 },
      { from: 'contact', text: 'Unos 12 creo\nTe paso las medidas después', minutesAgo: 70 },
    ],
  },
  {
    waId: '+5491100000203',
    name: 'Prueba <b>HTML</b>',
    channel: 'principal',
    score: 35,
    tier: 'cold',
    messages: [
      {
        from: 'contact',
        text: '<img src=x onerror=alert(1)> y *negrita* https://example.test',
        minutesAgo: 120,
      },
    ],
  },
  {
    waId: '+5491100000204',
    name: 'Marta Díaz',
    channel: 'principal',
    score: 71,
    tier: 'hot',
    pausedHours: 10,
    messages: [
      { from: 'contact', text: '¿Hacen envíos a Quilmes?', minutesAgo: 200 },
      { from: 'user', text: 'Hola Marta, sí. ¿Me pasás la dirección?', minutesAgo: 190 },
      { from: 'contact', text: null, type: 'audio', minutesAgo: 185 },
    ],
  },
  {
    waId: '+5491100000205',
    name: 'Lucas Romero',
    channel: 'sucursal',
    score: 55,
    tier: 'warm',
    messages: [{ from: 'contact', text: 'Hola, ¿abren el sábado?', minutesAgo: 15 }],
  },
  {
    waId: '+5491100000206',
    name: 'Sofía Herrera',
    channel: 'sucursal',
    score: 90,
    tier: 'hot',
    handoff: {
      reason: 'payment_or_reservation',
      summary: 'Quiere reservar 30 cajas y pagar con transferencia.',
    },
    messages: [{ from: 'contact', text: 'Quiero reservar 30 cajas, ¿cómo pago?', minutesAgo: 45 }],
  },
  // Tarea 024: los estados de los mensajes salientes (con dos envíos fallidos en el outbox).
  {
    waId: '+5491100000207',
    name: 'Carla Estados',
    channel: 'principal',
    score: 28,
    tier: 'cold',
    messages: [
      { from: 'contact', text: 'Hola, ¿tienen guardas para cocina?', minutesAgo: 180 },
      { from: 'ai', text: '¡Hola Carla! Sí, ¿qué medida buscás?', minutesAgo: 179, status: 'read' },
      { from: 'contact', text: 'De 8 cm de alto, en blanco', minutesAgo: 170 },
      { from: 'user', text: 'Te paso las opciones que tenemos', minutesAgo: 160, status: 'delivered' },
      { from: 'user', text: 'Son 3 modelos, el más pedido es el liso', minutesAgo: 159, status: 'sent' },
    ],
    failedOutbound: [
      { text: 'Te mando las fotos por acá', minutesAgo: 150, lastError: 'invalid_recipient' },
      { text: '¿Te sirve alguno de esos?', minutesAgo: 140, lastError: 'unknown_outcome' },
    ],
  },
  // Tarea 024: el cliente escribió hace más de 24 h (no se le puede responder desde el panel).
  {
    waId: '+5491100000208',
    name: 'Diego Ventana',
    channel: 'principal',
    score: 40,
    tier: 'cold',
    messages: [{ from: 'contact', text: 'Hola, ¿qué precio tiene el adhesivo?', minutesAgo: 2 * DAY }],
  },
  // Tarea 024: el e2e de Playwright le responde desde el panel (con el proveedor de WhatsApp falso).
  {
    waId: '+5491100000209',
    name: 'Elena Respuesta',
    channel: 'principal',
    score: 45,
    tier: 'warm',
    messages: [{ from: 'contact', text: '¿Me pasan el horario del local?', minutesAgo: 20 }],
  },
];

async function ensureInboxDemo(tenantId: string, ownerId: string, sellerId: string) {
  await appDatabase.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    const [principal] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.phoneNumber, MESSAGING['ceramicos-demo'].channelPhone));
    let [sucursal] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.phoneNumber, SUCURSAL.phone));
    if (!sucursal) {
      const now = new Date();
      [sucursal] = await tx
        .insert(channels)
        .values({
          tenantId,
          name: SUCURSAL.name,
          phoneNumber: SUCURSAL.phone,
          provider: 'waha',
          connectionType: 'unofficial',
          externalId: SUCURSAL.session,
          status: 'connected',
          riskAcceptedAt: now,
          riskAcceptedBy: ownerId,
        })
        .returning({ id: channels.id });
    }
    const channelIds = { principal: principal!.id, sucursal: sucursal!.id };
    // Tarea 011: "conectado desde" en Canales (los canales del seed se crearon conectados).
    await tx
      .update(channels)
      .set({ connectedAt: sql`COALESCE(${channels.connectedAt}, ${channels.createdAt})` })
      .where(and(inArray(channels.id, [principal!.id, sucursal!.id]), eq(channels.status, 'connected')));
    // Tarea 024: la sucursal tiene los envíos pausados por riesgo de bloqueo (el panel lo explica y no deja
    // responder). Se vuelve a poner en cada corrida.
    await tx
      .update(channels)
      .set({ sendingPausedUntil: sql`'infinity'::timestamptz`, sendingPausedReason: 'blocked_risk:463' })
      .where(eq(channels.id, sucursal!.id));

    for (const lead of DEMO_LEADS) {
      const channelId = channelIds[lead.channel];
      const [contact] = await tx
        .insert(contacts)
        .values({
          tenantId,
          waId: lead.waId,
          profileName: lead.name,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({ target: [contacts.tenantId, contacts.waId], set: { profileName: lead.name } })
        .returning({ id: contacts.id });
      let [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.contactId, contact!.id), eq(conversations.channelId, channelId)));
      if (!conversation) {
        [conversation] = await tx
          .insert(conversations)
          .values({ tenantId, channelId, contactId: contact!.id, lastMessageAt: new Date() })
          .returning({ id: conversations.id });
        await tx.insert(messages).values(
          lead.messages.map((message, index) => ({
            tenantId,
            conversationId: conversation!.id,
            channelId,
            externalId: `seed-${lead.waId}-${index}`,
            direction: message.from === 'contact' ? 'inbound' : 'outbound',
            senderType: message.from,
            sentByUserId: message.from === 'user' ? ownerId : null,
            type: message.type ?? 'text',
            body: message.text,
            status: message.from === 'contact' ? 'received' : (message.status ?? 'read'),
            raw: { seed: true },
            sentAt: new Date(Date.now() - message.minutesAgo * 60_000),
          })),
        );
        if (lead.failedOutbound?.length) {
          await tx.insert(outboundMessages).values(
            lead.failedOutbound.map((failed, index) => ({
              tenantId,
              conversationId: conversation!.id,
              channelId,
              idempotencyKey: `seed-${lead.waId}-failed-${index}`,
              senderType: 'user',
              sentByUserId: ownerId,
              body: failed.text,
              status: 'failed',
              lastError: failed.lastError,
              attempts: 1,
              claimedAt: new Date(Date.now() - failed.minutesAgo * 60_000),
              createdAt: new Date(Date.now() - failed.minutesAgo * 60_000),
            })),
          );
        }
      }
      const lastMinutes = Math.min(...lead.messages.map((message) => message.minutesAgo));
      const lastInboundMinutes = Math.min(
        ...lead.messages.filter((message) => message.from === 'contact').map((message) => message.minutesAgo),
      );
      // El estado del lead (lo escriben el worker de la IA y el panel) vuelve al de demo en cada corrida.
      await tx.execute(sql`
        UPDATE conversations SET
          lead_score = ${lead.score}, lead_score_peak = ${lead.score}, lead_tier = ${lead.tier},
          lead_score_at = now(), qualification_turns = 2, hot_turns = 0,
          extracted_data = ${JSON.stringify(lead.extracted ?? {})}::jsonb,
          handed_off_at = ${lead.handoff ? sql`now() - interval '5 minutes'` : sql`NULL`},
          handoff_reason = ${lead.handoff?.reason ?? null},
          handoff_summary = ${lead.handoff?.summary ?? null},
          ai_paused_until = ${lead.pausedHours ? sql`now() + make_interval(hours => ${lead.pausedHours})` : sql`NULL`},
          last_message_at = now() - make_interval(mins => ${lastMinutes}),
          last_inbound_at = now() - make_interval(mins => ${lastInboundMinutes})
        WHERE id = ${conversation!.id}
      `);
    }

    // multi@ (seller) atiende solo el número principal.
    await tx.execute(sql`
      INSERT INTO channel_members (tenant_id, channel_id, user_id, created_by)
      VALUES (${tenantId}, ${channelIds.principal}, ${sellerId}, ${ownerId})
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      DELETE FROM channel_members WHERE channel_id = ${channelIds.sucursal} AND user_id = ${sellerId}
    `);
  });
}

// Los leads de demo vuelven a estar "sin ver" para los usuarios del seed (los e2e los abren). La RLS de
// conversation_reads solo deja tocar las filas propias: se hace con el contexto de cada usuario.
async function resetDemoReads(tenantId: string, userIds: string[]) {
  const waIds = DEMO_LEADS.map((lead) => lead.waId);
  for (const userId of userIds) {
    await appDatabase.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
      await tx.execute(sql`
        UPDATE conversation_reads r SET last_read_at = '-infinity'
        FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
        WHERE r.conversation_id = c.id AND ct.wa_id = ANY (${sql.param(waIds)}::text[])
      `);
    });
  }
}

try {
  const userIds = new Map<string, string>();
  for (const user of USERS) userIds.set(user.email, await ensureUser(user.email, user.name));

  const tenantIds = new Map<string, string>();
  tenantIds.set('ceramicos-demo', await ensureTenant(TENANTS[0], userIds.get(USERS[0].email)!));
  tenantIds.set('inmobiliaria-demo', await ensureTenant(TENANTS[1], userIds.get(USERS[1].email)!));

  for (const [email, slug, role, status] of EXTRA_MEMBERSHIPS) {
    const userId = userIds.get(email)!;
    const tenantId = tenantIds.get(slug)!;
    const where = and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId));
    const [existing] = await db.select({ id: memberships.id }).from(memberships).where(where);
    if (!existing) await auth.api.addMember({ body: { userId, organizationId: tenantId, role } });
    // status es columna nuestra (input: false en el plugin): se setea directo en la tabla.
    await db.update(memberships).set({ status }).where(where);
  }

  await ensureMessaging('ceramicos-demo', tenantIds.get('ceramicos-demo')!, userIds.get(USERS[0].email)!);
  await ensureMessaging(
    'inmobiliaria-demo',
    tenantIds.get('inmobiliaria-demo')!,
    userIds.get(USERS[1].email)!,
  );

  await ensureInboxDemo(
    tenantIds.get('ceramicos-demo')!,
    userIds.get(USERS[0].email)!,
    userIds.get('multi@example.test')!,
  );
  await resetDemoReads(tenantIds.get('ceramicos-demo')!, [...userIds.values()]);

  console.log(
    `Seed listo: ${tenantIds.size} empresas, ${userIds.size} usuarios, conversaciones de prueba y leads de demo en Cerámicos.`,
  );
  console.log('Usuarios de prueba (contraseña: SEED_PASSWORD en apps/api/scripts/seed.ts):');
  for (const user of USERS) console.log(`  - ${user.email}`);
} finally {
  await Promise.all([authDatabase.close(), appDatabase.close()]);
}
