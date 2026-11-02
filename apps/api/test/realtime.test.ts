// Verificación de la tarea 025 contra el Postgres local: GET /api/events (SSE) con clientes reales.
// Eventos de un entrante por el webhook de WAHA, filtro por empresa y número, visibilidad dinámica, cierre
// del stream (logout, sesión revocada, membresía desactivada), aviso solo después del commit, contenido de
// los avisos, límite por usuario, latido y reconexión del listener. Números ficticios.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { APP_DB, type AppDatabase } from '../src/db/database.module.js';
import { setDbContext } from '../src/db/tenant-context.js';
import { BOSS, QUEUES } from '../src/jobs/jobs.module.js';
import { OutboundWorker } from '../src/messaging/outbound/outbound.worker.js';
import { applyChannelFailure } from '../src/messaging/outbound/outbound.service.js';
import { INBOX_EVENTS_CHANNEL, publishConversationEvent } from '../src/realtime/publish.js';
import { RealtimeHub } from '../src/realtime/realtime-hub.js';
import { RealtimeListener } from '../src/realtime/realtime-listener.js';
import { InboundService } from '../src/whatsapp/inbound/inbound.service.js';
import { WHATSAPP_PROVIDER_REGISTRY, type WhatsAppProviderRegistry } from '../src/whatsapp/provider.js';
import {
  addMember,
  createTenant,
  createUser,
  HttpClient,
  postWahaWebhook,
  startTestContext,
  waitFor,
  withTenant,
  type TestContext,
} from './helpers.js';
import { SseClient } from './sse-helpers.js';

// Antes de levantar la app: latido rápido, sin revalidación periódica (así lo que corta un stream en estos
// tests son los avisos, salvo donde se llama a revalidateAll a propósito) y 3 streams por usuario.
process.env.REALTIME_HEARTBEAT_SECONDS = '1';
process.env.REALTIME_REVALIDATE_SECONDS = '300';
process.env.REALTIME_MAX_STREAMS_PER_USER = '3';
// La IA no corre (un entrante encola ai-reply): nada sale a OpenRouter.
process.env.AI_ENABLED = 'false';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_NAME = 'Cliente Tiempo Real';
const MESSAGE_TEXT = 'Hola, quiero saber el precio del porcelanato gris';

let ctx: TestContext;
let db: AppDatabase['db'];
let hub: RealtimeHub;
type UserKey = 'owner' | 'seller' | 'seller2' | 'viewer' | 'ownerB';
const users = {} as Record<UserKey, { id: string; email: string }>;
const clients = {} as Record<UserKey, HttpClient>;
let tenantA: string;
let tenantB: string;
const channels = {} as Record<'A1' | 'A2' | 'B1', { id: string; session: string }>;
const streams: SseClient[] = [];
// Todo lo que pasó por NOTIFY en la corrida (lo escucha el test con su propia conexión).
let notifyClient: pg.Client;
const notified: string[] = [];
const phones: string[] = [];

const uid = () => randomBytes(8).toString('hex');

async function createChannel(tenantId: string, ownerId: string, label: string) {
  const session = `${ctx.prefix}_rt_${label}`;
  const id = await withTenant(ctx, tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type, external_id,
         status, risk_accepted_at, risk_accepted_by)
       VALUES ($1, $2, $3, 'waha', 'unofficial', $4, 'connected', now(), $5) RETURNING id`,
      [
        tenantId,
        label,
        `+549110${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
        session,
        ownerId,
      ],
    );
    return rows[0]!.id;
  });
  return { id, session };
}

async function login(key: UserKey, tenantId: string): Promise<HttpClient> {
  const client = new HttpClient(ctx);
  expect((await client.signIn(users[key].email)).status).toBe(200);
  expect((await client.post('/api/auth/organization/set-active', { organizationId: tenantId })).status).toBe(
    200,
  );
  return client;
}

async function open(client: HttpClient | null): Promise<SseClient> {
  const stream = await SseClient.open(ctx, client ? client.cookieHeader() : null);
  streams.push(stream);
  return stream;
}

/** Entrante de texto por el webhook firmado de WAHA, como lo manda WAHA. Devuelve el teléfono. */
async function inbound(channel: { session: string }): Promise<string> {
  const base = JSON.parse(
    readFileSync(new URL('./fixtures/whatsapp/waha/message-text.json', import.meta.url), 'utf8'),
  ) as { payload: Record<string, unknown> };
  const phone = `54911${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  phones.push(phone);
  const from = `${phone}@c.us`;
  const key = uid().toUpperCase();
  const envelope = {
    ...base,
    id: `evt_${uid()}`,
    session: channel.session,
    payload: {
      ...base.payload,
      id: `false_${from}_${key}`,
      from,
      timestamp: Math.floor(Date.now() / 1000),
      body: MESSAGE_TEXT,
      _data: { key: { remoteJid: from, fromMe: false, id: key }, pushName: CLIENT_NAME },
    },
  };
  expect(await postWahaWebhook(ctx, JSON.stringify(envelope))).toBe(200);
  return phone;
}

async function conversationOf(phone: string): Promise<string> {
  return waitFor(async () => {
    const { rows } = await ctx.ownerPool.query<{ id: string }>(
      `SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1`,
      [`+${phone}`],
    );
    return rows[0]?.id;
  });
}

/** Un aviso de una conversación (inventada) del número, publicado con commit. */
async function notice(tenantId: string, channelId: string, conversationId = randomUUID()): Promise<string> {
  await db.transaction(async (tx) => {
    await setDbContext(tx, { tenantId });
    await publishConversationEvent(tx, 'conversation.updated', { tenantId, channelId, conversationId });
  });
  return conversationId;
}

beforeAll(async () => {
  ctx = await startTestContext();
  db = ctx.app.get<AppDatabase>(APP_DB).db;
  hub = ctx.app.get(RealtimeHub);
  await ctx.app.get<PgBoss>(BOSS).offWork(QUEUES.whatsappOutbound);
  notifyClient = new pg.Client({ connectionString: ctx.env.DATABASE_URL });
  await notifyClient.connect();
  notifyClient.on('notification', (message) => notified.push(message.payload ?? ''));
  await notifyClient.query(`LISTEN ${INBOX_EVENTS_CHANNEL}`);

  for (const k of ['owner', 'seller', 'seller2', 'viewer', 'ownerB'] as const) {
    users[k] = await createUser(ctx, `rt-${k}`);
  }
  tenantA = await createTenant(ctx, 'rt-a', users.owner.id);
  tenantB = await createTenant(ctx, 'rt-b', users.ownerB.id);
  await addMember(ctx, tenantA, users.seller.id, 'seller');
  await addMember(ctx, tenantA, users.seller2.id, 'seller');
  await addMember(ctx, tenantA, users.viewer.id, 'viewer');
  channels.A1 = await createChannel(tenantA, users.owner.id, 'a1');
  channels.A2 = await createChannel(tenantA, users.owner.id, 'a2');
  channels.B1 = await createChannel(tenantB, users.ownerB.id, 'b1');
  for (const k of ['owner', 'seller', 'seller2', 'viewer'] as const) clients[k] = await login(k, tenantA);
  clients.ownerB = await login('ownerB', tenantB);
  // seller: A1. seller2: A2.
  for (const [channel, seller] of [
    [channels.A1.id, users.seller.id],
    [channels.A2.id, users.seller2.id],
  ] as const) {
    const assign = await clients.owner.request('PUT', `/api/channels/${channel}/members`, {
      userIds: [seller],
    });
    expect(assign.status).toBe(200);
  }
});

// Un test que falla no deja streams abiertos ocupando el cupo del usuario en los siguientes.
afterEach(() => {
  for (const stream of streams) stream.close();
});

afterAll(async () => {
  for (const stream of streams) stream.close();
  await notifyClient?.end();
  await ctx?.close();
});

describe('1. acceso al stream', () => {
  it('sin sesión 401; el viewer (sin permiso de conversaciones) 403', async () => {
    expect((await open(null)).status).toBe(401);
    expect((await open(clients.viewer)).status).toBe(403);
  });

  it('abierto, no deja una transacción tomada (no ocupa una conexión de la base)', async () => {
    const stream = await open(clients.owner);
    expect(stream.status).toBe(200);
    const { rows } = await ctx.ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE application_name = 'ventas-api' AND state LIKE 'idle in transaction%'`,
    );
    expect(rows[0]!.n).toBe(0);
    stream.close();
  });
});

describe('2. entrante por el webhook', () => {
  it('el owner y el seller del número reciben message.created; el seller de otro número no', async () => {
    const owner = await open(clients.owner);
    const seller = await open(clients.seller);
    const seller2 = await open(clients.seller2);
    const ownerB = await open(clients.ownerB);

    const started = Date.now();
    const conversationId = await conversationOf(await inbound(channels.A1));
    const event = await owner.waitForEvent(conversationId);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(JSON.parse(event.data)).toEqual({ type: 'message.created', conversationId });
    await seller.waitForEvent(conversationId);

    // Control positivo, en orden: seller2 recibe el aviso de A2 (publicado después) y nunca el de A1. Lo
    // mismo para la otra empresa con su número.
    const a2 = await notice(tenantA, channels.A2.id);
    const b1 = await notice(tenantB, channels.B1.id);
    await seller2.waitForEvent(a2);
    await ownerB.waitForEvent(b1);
    expect(seller2.hasEventFor(conversationId)).toBe(false);
    expect(ownerB.hasEventFor(conversationId)).toBe(false);
    expect(ownerB.hasEventFor(a2)).toBe(false);
    expect(seller.hasEventFor(a2)).toBe(false);
    for (const stream of [owner, seller, seller2, ownerB]) stream.close();
  });

  it('marcar leída avisa solo a los streams de quien la leyó', async () => {
    const owner = await open(clients.owner);
    const seller = await open(clients.seller);
    const conversationId = await conversationOf(await inbound(channels.A1));
    await owner.waitForEvent(conversationId);
    await seller.waitForEvent(conversationId);

    expect((await clients.seller.post(`/api/conversations/${conversationId}/read`)).status).toBe(204);
    await seller.waitFor((m) => m.data.includes('conversation.read'));
    const marker = await notice(tenantA, channels.A1.id);
    await owner.waitForEvent(marker);
    expect(owner.events.some((event) => event.type === 'conversation.read')).toBe(false);
    owner.close();
    seller.close();
  });
});

describe('3. visibilidad dinámica', () => {
  it('al quitarle el número a un seller, deja de recibir los eventos de ese número (sin reconectar)', async () => {
    // seller ve A1 y A2; después se le saca A1.
    expect(
      (
        await clients.owner.request('PUT', `/api/channels/${channels.A2.id}/members`, {
          userIds: [users.seller2.id, users.seller.id],
        })
      ).status,
    ).toBe(200);
    const seller = await open(clients.seller);
    await seller.waitForEvent(await notice(tenantA, channels.A1.id));

    expect(
      (await clients.owner.request('PUT', `/api/channels/${channels.A1.id}/members`, { userIds: [] })).status,
    ).toBe(200);
    // La revalidación es asíncrona (la dispara el aviso access, no un timer: la periódica está en 300 s).
    // Se repite hasta que un aviso de A1 ya no llega antes que el control de A2.
    await waitFor(async () => {
      const a1 = await notice(tenantA, channels.A1.id);
      const a2 = await notice(tenantA, channels.A2.id);
      await seller.waitForEvent(a2);
      return !seller.hasEventFor(a1);
    }, 5_000);
    expect(seller.closed).toBe(false);
    seller.close();

    // Vuelve a como estaba.
    await clients.owner.request('PUT', `/api/channels/${channels.A1.id}/members`, {
      userIds: [users.seller.id],
    });
    await clients.owner.request('PUT', `/api/channels/${channels.A2.id}/members`, {
      userIds: [users.seller2.id],
    });
  });
});

describe('4. cierre del stream', () => {
  it('logout cierra el stream con end/unauthenticated', async () => {
    const client = await login('seller2', tenantA);
    const stream = await open(client);
    expect((await client.post('/api/auth/sign-out')).status).toBe(200);
    await stream.waitClosed(3_000);
    expect(stream.messages.at(-1)).toEqual({
      event: 'end',
      data: JSON.stringify({ reason: 'unauthenticated' }),
    });
  });

  it('revocar las otras sesiones cierra el stream de la sesión revocada y no el propio', async () => {
    const first = await login('seller2', tenantA);
    const second = await login('seller2', tenantA);
    const revoked = await open(second);
    const own = await open(first);
    expect((await first.post('/api/auth/revoke-other-sessions')).status).toBe(200);
    await revoked.waitClosed(3_000);
    expect(revoked.messages.at(-1)?.data).toBe(JSON.stringify({ reason: 'unauthenticated' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(own.closed).toBe(false);
    own.close();
  });

  it('membresía desactivada: la revalidación periódica cierra el stream con end/forbidden', async () => {
    const client = await login('seller2', tenantA);
    const stream = await open(client);
    await ctx.ownerPool.query(
      `UPDATE memberships SET status = 'disabled' WHERE tenant_id = $1 AND user_id = $2`,
      [tenantA, users.seller2.id],
    );
    try {
      await hub.revalidateAll();
      await stream.waitClosed(3_000);
      expect(stream.messages.at(-1)?.data).toBe(JSON.stringify({ reason: 'forbidden' }));
      expect((await open(client)).status).toBe(403);
    } finally {
      await ctx.ownerPool.query(
        `UPDATE memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2`,
        [tenantA, users.seller2.id],
      );
    }
  });
});

describe('4b. puntos de publicación (empresa y número correctos)', () => {
  it('respuesta del panel, worker de envío y acuse: llegan al owner y al seller del número, no al de otro', async () => {
    const owner = await open(clients.owner);
    const seller = await open(clients.seller);
    const seller2 = await open(await login('seller2', tenantA));
    const conversationId = await conversationOf(await inbound(channels.A1));
    await seller.waitForEvent(conversationId);
    const sinceInbound = owner.events.length;

    // ReplyService.send: message.created (enqueueText) y conversation.updated (IA pausada).
    const reply = await clients.seller.post(`/api/conversations/${conversationId}/messages`, {
      body: 'Te escribo enseguida',
      idempotencyKey: randomUUID(),
    });
    expect(reply.status).toBe(200);
    await owner.waitFor((m) => m.data === JSON.stringify({ type: 'conversation.updated', conversationId }));
    await owner.waitFor((m) => m.data === JSON.stringify({ type: 'message.created', conversationId }));

    // Worker de envío (con el proveedor falso de la app): sending y sent → message.updated.
    const worker = new OutboundWorker(
      ctx.app.get<PgBoss>(BOSS),
      ctx.app.get<WhatsAppProviderRegistry>(WHATSAPP_PROVIDER_REGISTRY),
      ctx.app.get<AppDatabase>(APP_DB),
      { sleep: async () => {}, random: () => 0.5 },
    );
    const { rows } = await ctx.ownerPool.query<{ id: string }>(
      `SELECT id FROM outbound_messages WHERE conversation_id = $1 AND sender_type = 'user'`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(
      await worker.handle(
        { outboundId: rows[0]!.id, tenantId: tenantA },
        { id: randomUUID(), retryCount: 0, retryLimit: 5 },
      ),
    ).toBe('enviado');
    await waitFor(
      async () =>
        owner.events
          .slice(sinceInbound)
          .filter((e) => e.type === 'message.updated' && e.conversationId === conversationId).length >= 2,
      5_000,
    );

    // Acuse "entregado" de ese mensaje → message.updated.
    const { rows: sent } = await ctx.ownerPool.query<{ external_id: string }>(
      `SELECT external_id FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`,
      [conversationId],
    );
    const before = owner.events.length;
    await ctx.app.get(InboundService).process(
      {
        type: 'message.status',
        provider: 'waha',
        channelExternalId: channels.A1.session,
        eventId: `evt_${uid()}`,
        externalMessageId: sent[0]!.external_id,
        status: 'delivered',
      },
      { channelId: channels.A1.id, tenantId: tenantA },
    );
    await waitFor(async () => owner.events.slice(before).some((e) => e.type === 'message.updated'), 3_000);
    await seller.waitFor((m) => m.data.includes('message.updated'));

    // Control: seller2 (A2) recibe un aviso de su número publicado después y ninguno de esta conversación.
    await seller2.waitForEvent(await notice(tenantA, channels.A2.id));
    expect(seller2.hasEventFor(conversationId)).toBe(false);
    for (const stream of [owner, seller, seller2]) stream.close();
  });

  it('estado del canal (webhook) y falla del canal en un envío → channel.updated solo a quien ve el número', async () => {
    const owner = await open(clients.owner);
    const seller = await open(clients.seller);
    const seller2 = await open(await login('seller2', tenantA));
    const inbound = ctx.app.get(InboundService);
    await inbound.process(
      {
        type: 'session.status',
        provider: 'waha',
        channelExternalId: channels.A1.session,
        eventId: `evt_${uid()}`,
        status: 'disconnected',
        phoneNumber: null,
        failed: false,
      },
      { channelId: channels.A1.id, tenantId: tenantA },
    );
    await owner.waitForEvent(channels.A1.id);
    await seller.waitForEvent(channels.A1.id);
    expect(owner.events).toContainEqual({ type: 'channel.updated', channelId: channels.A1.id });
    await ctx.ownerPool.query(`UPDATE channels SET status = 'connected' WHERE id = $1`, [channels.A1.id]);

    // applyChannelFailure (session_down) dentro de la transacción del worker.
    const before = owner.events.length;
    await db.transaction(async (tx) => {
      await setDbContext(tx, { tenantId: tenantA });
      await applyChannelFailure(tx, channels.A1.id, { ok: false, error: 'session_down', code: 'test' });
    });
    await waitFor(async () => owner.events.slice(before).some((e) => e.channelId === channels.A1.id), 3_000);
    await ctx.ownerPool.query(`UPDATE channels SET status = 'connected' WHERE id = $1`, [channels.A1.id]);

    await seller2.waitForEvent(await notice(tenantA, channels.A2.id));
    expect(seller2.hasEventFor(channels.A1.id)).toBe(false);
    for (const stream of [owner, seller, seller2]) stream.close();
  });

  it('cambiar la empresa activa cierra el stream con end/tenant_changed', async () => {
    await addMember(ctx, tenantB, users.seller2.id, 'seller');
    const client = await login('seller2', tenantA);
    const stream = await open(client);
    expect((await client.post('/api/auth/organization/set-active', { organizationId: tenantB })).status).toBe(
      200,
    );
    await stream.waitClosed(3_000);
    expect(stream.messages.at(-1)?.data).toBe(JSON.stringify({ reason: 'tenant_changed' }));
  });
});

describe('5. el aviso sale después del commit', () => {
  it('si la transacción hace rollback no hay evento; la que hace commit sí llega', async () => {
    const owner = await open(clients.owner);
    const rolledBack = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await setDbContext(tx, { tenantId: tenantA });
        await publishConversationEvent(tx, 'conversation.updated', {
          tenantId: tenantA,
          channelId: channels.A1.id,
          conversationId: rolledBack,
        });
        throw new Error('rollback a propósito');
      }),
    ).rejects.toThrow('rollback a propósito');
    const committed = await notice(tenantA, channels.A1.id);
    await owner.waitForEvent(committed);
    expect(owner.hasEventFor(rolledBack)).toBe(false);
    expect(notified.some((payload) => payload.includes(rolledBack))).toBe(false);
    owner.close();
  });

  it('una respuesta del panel rechazada (409, rollback) no avisa nada', async () => {
    const owner = await open(clients.owner);
    const conversationId = await conversationOf(await inbound(channels.A1));
    await owner.waitForEvent(conversationId);
    const before = owner.events.length;
    await ctx.ownerPool.query(`UPDATE channels SET status = 'disconnected' WHERE id = $1`, [channels.A1.id]);
    try {
      const response = await clients.owner.post(`/api/conversations/${conversationId}/messages`, {
        body: 'Hola',
        idempotencyKey: randomUUID(),
      });
      expect(response.status).toBe(409);
      const marker = await notice(tenantA, channels.A1.id);
      await owner.waitForEvent(marker);
      expect(owner.events.slice(before).filter((event) => event.conversationId === conversationId)).toEqual(
        [],
      );
    } finally {
      await ctx.ownerPool.query(`UPDATE channels SET status = 'connected' WHERE id = $1`, [channels.A1.id]);
    }
    owner.close();
  });
});

describe('6. contenido de los avisos', () => {
  it('solo type e identificadores: ni texto, ni nombres, ni teléfonos (en NOTIFY ni en el stream)', async () => {
    const owner = await open(clients.owner);
    const conversationId = await conversationOf(await inbound(channels.A1));
    await owner.waitForEvent(conversationId);
    expect((await clients.owner.post(`/api/conversations/${conversationId}/reactivate-ai`)).status).toBe(200);
    await clients.owner.post(`/api/conversations/${conversationId}/read`);
    await owner.waitFor((m) => m.data.includes('conversation.read'));

    const sent = owner.events;
    expect(sent.length).toBeGreaterThan(0);
    for (const event of sent) {
      for (const [key, value] of Object.entries(event)) {
        expect(['type', 'conversationId', 'channelId']).toContain(key);
        if (key !== 'type') expect(value).toMatch(UUID);
      }
    }
    expect(notified.length).toBeGreaterThan(0);
    for (const payload of notified) {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        expect([
          'kind',
          'type',
          'tenantId',
          'channelId',
          'conversationId',
          'userId',
          'sessionHash',
        ]).toContain(key);
        if (key === 'sessionHash') expect(value).toMatch(/^[0-9a-f]{64}$/);
        else if (key !== 'kind' && key !== 'type') expect(value).toMatch(UUID);
      }
    }
    const everything = [owner.raw, ...notified].join('\n');
    expect(everything).not.toContain(CLIENT_NAME);
    expect(everything).not.toContain(MESSAGE_TEXT);
    for (const phone of phones) expect(everything).not.toContain(phone.slice(-8));
    owner.close();
  });
});

describe('7. límites, latido y reconexión', () => {
  it('3 streams por usuario: el cuarto recibe 429 y, al cerrar uno, se puede abrir otro', async () => {
    const client = await login('seller', tenantA);
    const opened = [await open(client), await open(client), await open(client)];
    const extra = await open(client);
    expect(extra.status).toBe(429);
    opened[0]!.close();
    await waitFor(async () => hub.countFor(users.seller.id) < 3, 3_000);
    const again = await open(client);
    expect(again.status).toBe(200);
    for (const stream of [...opened, again]) stream.close();
  });

  it('pedidos en paralelo no pasan el límite por usuario', async () => {
    const client = await login('seller', tenantA);
    const opened = await Promise.all(Array.from({ length: 10 }, () => open(client)));
    expect(opened.filter((stream) => stream.status === 200)).toHaveLength(3);
    expect(opened.filter((stream) => stream.status === 429)).toHaveLength(7);
    for (const stream of opened) stream.close();
    await waitFor(async () => hub.countFor(users.seller.id) === 0, 3_000);
  });

  it('una acción de Better Auth que falla (anónimo) no publica avisos', async () => {
    const before = notified.length;
    const anonymous = new HttpClient(ctx);
    const failed = await anonymous.post('/api/auth/organization/remove-member', {
      organizationId: tenantA,
      memberIdOrEmail: users.seller2.email,
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const banned = await anonymous.post('/api/auth/admin/ban-user', { userId: users.seller.id });
    expect(banned.status).toBeGreaterThanOrEqual(400);
    // Control: un aviso propio llega, y antes no hubo ninguno de esos pedidos.
    const marker = await notice(tenantA, channels.A1.id);
    await waitFor(async () => notified.some((payload) => payload.includes(marker)), 3_000);
    const since = notified.slice(before).map((payload) => JSON.parse(payload) as { kind: string });
    expect(since.filter((parsed) => parsed.kind === 'access' || parsed.kind === 'user')).toEqual([]);
  });

  it('un pedido que se corta antes de quedar abierto no queda contado', async () => {
    const client = await login('seller', tenantA);
    const limit = ctx.env.REALTIME_MAX_STREAMS_PER_USER;
    // Se frena el cálculo del scope para cortar los pedidos justo ahí, con su lugar ya reservado (sin
    // depender de cuánto tarda el guard). Se guarda la respuesta de cada uno para saber cuándo la API vio
    // el corte.
    type Hub = {
      open: RealtimeHub['open'];
      resolveScope: (context: unknown) => Promise<unknown>;
    };
    const spied = hub as unknown as Hub;
    const originalOpen = spied.open;
    const originalScope = spied.resolveScope;
    const responses: { destroyed: boolean }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    spied.open = (session, context, cookie, response) => {
      responses.push(response);
      return originalOpen.call(hub, session, context, cookie, response);
    };
    spied.resolveScope = async (context) => {
      await gate;
      return originalScope.call(hub, context);
    };
    try {
      const aborts = Array.from({ length: limit }, () => new AbortController());
      const pending = aborts.map((abort) =>
        fetch(`${ctx.baseUrl}/api/events`, {
          headers: { Cookie: client.cookieHeader() },
          signal: abort.signal,
        }).catch(() => undefined),
      );
      // Los N pedidos están adentro, calculando el scope: ocupan todos los lugares del usuario.
      await waitFor(async () => hub.countFor(users.seller.id) === limit, 5_000);
      for (const abort of aborts) abort.abort();
      await Promise.all(pending);
      await waitFor(async () => responses.length === limit && responses.every((r) => r.destroyed), 5_000);
    } finally {
      spied.open = originalOpen;
      spied.resolveScope = originalScope;
      release();
    }
    // Al terminar el scope, los cortados liberan su lugar y no se registran: el usuario puede abrir uno.
    await waitFor(async () => hub.countFor(users.seller.id) === 0, 3_000);
    const stream = await open(client);
    expect(stream.status).toBe(200);
    stream.close();
  });

  it('manda el latido (comentario SSE) periódicamente', async () => {
    const stream = await open(clients.owner);
    await waitFor(async () => stream.pings >= 2, 4_000);
    stream.close();
  });

  it('si se cae la conexión de LISTEN, reconecta, manda resync y los avisos siguen llegando', async () => {
    const stream = await open(clients.owner);
    const listener = ctx.app.get(RealtimeListener);
    listener.simulateDrop();
    await stream.waitFor((m) => m.event === 'resync', 5_000);
    expect(listener.connected).toBe(true);
    await stream.waitForEvent(await notice(tenantA, channels.A1.id));
    stream.close();
  });
});
