// Verificación de la tarea 024 contra el Postgres local: responder desde el panel (permisos y visibilidad
// por número, idempotencia, reglas de envío con 409, pausa de la IA y respuestas de la IA en cola), el
// estado de cada mensaje en la lista y "sin responder". Los envíos quedan en cola: el worker de la app no
// toma trabajos en estos tests. Números ficticios.
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_DB, type AppDatabase } from '../src/db/database.module.js';
import { withTenantTransaction } from '../src/db/tenant-context.js';
import { BOSS, QUEUES } from '../src/jobs/jobs.module.js';
import { OutboundService } from '../src/messaging/outbound/outbound.service.js';
import {
  addMember,
  createTenant,
  createUser,
  HttpClient,
  startTestContext,
  withTenant,
  type TestContext,
} from './helpers.js';
import { OutboundWorker } from '../src/messaging/outbound/outbound.worker.js';
import { attempt, fakeBoss, fakePhone, FakeProvider, registryWith, uid } from './outbound-helpers.js';

let ctx: TestContext;

type UserKey = 'owner' | 'admin' | 'seller' | 'seller2' | 'viewer' | 'ownerB';
const users = {} as Record<UserKey, { id: string; email: string }>;
const clients = {} as Record<UserKey, HttpClient>;
let tenantA: string;
let tenantB: string;
// A1: asignado al seller. A2: sin asignar. B1: otra empresa.
const channels = {} as Record<'A1' | 'A2' | 'B1', string>;

async function createChannel(tenantId: string, ownerId: string, name: string) {
  return withTenant(ctx, tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type, external_id,
         status, risk_accepted_at, risk_accepted_by)
       VALUES ($1, $2, $3, 'waha', 'unofficial', $4, 'connected', now(), $5) RETURNING id`,
      [tenantId, name, `+${fakePhone()}`, `${ctx.prefix}_${uid()}`, ownerId],
    );
    return rows[0]!.id;
  });
}

/** Conversación con un entrante de hace `inboundAgo` (o sin entrantes, con null). */
async function createConversation(tenantId: string, channelId: string, inboundAgo: string | null = '1 hour') {
  return withTenant(ctx, tenantId, async (c) => {
    const contact = await c.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, wa_id, profile_name, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'Cliente', now(), now()) RETURNING id`,
      [tenantId, `+${fakePhone()}`],
    );
    const conversation = await c.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, channel_id, contact_id, last_message_at, last_inbound_at)
       VALUES ($1, $2, $3, now(), now() - $4::interval) RETURNING id`,
      [tenantId, channelId, contact.rows[0]!.id, inboundAgo],
    );
    const id = conversation.rows[0]!.id;
    if (inboundAgo !== null) {
      await c.query(
        `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
           type, body, status, raw, sent_at)
         VALUES ($1, $2, $3, $4, 'inbound', 'contact', 'text', 'Hola', 'received', '{}'::jsonb,
                 now() - $5::interval)`,
        [tenantId, id, channelId, `false_${uid()}`, inboundAgo],
      );
    }
    return id;
  });
}

async function login(key: UserKey, tenantId: string) {
  const client = new HttpClient(ctx);
  expect((await client.signIn(users[key].email)).status).toBe(200);
  expect((await client.post('/api/auth/organization/set-active', { organizationId: tenantId })).status).toBe(
    200,
  );
  clients[key] = client;
}

const send = (client: HttpClient, id: string, body: unknown) =>
  client.post(`/api/conversations/${id}/messages`, body);
const key = () => crypto.randomUUID();

async function outbox(conversationId: string) {
  const { rows } = await ctx.ownerPool.query(
    `SELECT id, sender_type, sent_by_user_id, idempotency_key, body, status, reject_reason
     FROM outbound_messages WHERE conversation_id = $1 ORDER BY created_at`,
    [conversationId],
  );
  return rows;
}

async function conversationRow(id: string) {
  const { rows } = await ctx.ownerPool.query(
    `SELECT ai_paused_until, ai_paused_until > now() + interval '11 hours 59 minutes' AS paused_12h
     FROM conversations WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** Una respuesta de la IA en la cola, como la deja la T2 de ai-reply (sin trabajo: el worker no corre). */
async function queueAiReply(tenantId: string, conversationId: string, channelId: string, status = 'queued') {
  const { rows } = await ctx.ownerPool.query<{ id: string }>(
    `INSERT INTO outbound_messages (tenant_id, conversation_id, channel_id, idempotency_key, sender_type, body,
       status, claimed_at)
     VALUES ($1, $2, $3, $4, 'ai', 'Respuesta de la IA', $5, CASE WHEN $5 = 'sending' THEN now() END)
     RETURNING id`,
    [tenantId, conversationId, channelId, `ai:${uid()}`, status],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  ctx = await startTestContext();
  // Los envíos quedan en cola: así el estado es determinístico (y nada llega a un proveedor).
  await ctx.app.get<PgBoss>(BOSS).offWork(QUEUES.whatsappOutbound);
  for (const k of ['owner', 'admin', 'seller', 'seller2', 'viewer', 'ownerB'] as const) {
    users[k] = await createUser(ctx, `reply-${k}`);
  }
  tenantA = await createTenant(ctx, 'reply-a', users.owner.id);
  tenantB = await createTenant(ctx, 'reply-b', users.ownerB.id);
  await addMember(ctx, tenantA, users.admin.id, 'admin');
  await addMember(ctx, tenantA, users.seller.id, 'seller');
  await addMember(ctx, tenantA, users.seller2.id, 'seller');
  await addMember(ctx, tenantA, users.viewer.id, 'viewer');
  channels.A1 = await createChannel(tenantA, users.owner.id, 'Ventas');
  channels.A2 = await createChannel(tenantA, users.owner.id, 'Sucursal');
  channels.B1 = await createChannel(tenantB, users.ownerB.id, 'Ventas B');
  for (const k of ['owner', 'admin', 'seller', 'seller2', 'viewer'] as const) await login(k, tenantA);
  await login('ownerB', tenantB);
  const assign = await clients.owner.request('PUT', `/api/channels/${channels.A1}/members`, {
    userIds: [users.seller.id],
  });
  expect(assign.status).toBe(200);
});

afterAll(async () => {
  await ctx?.close();
});

describe('1. enviar: quién puede', () => {
  it('owner, admin y el seller del número envían; queda en el outbox como user con quién lo mandó', async () => {
    for (const k of ['owner', 'admin', 'seller'] as const) {
      const id = await createConversation(tenantA, channels.A1);
      const idempotencyKey = key();
      const response = await send(clients[k], id, { body: '  Hola, te paso el precio\n', idempotencyKey });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        direction: 'outbound',
        senderType: 'user',
        sentByName: `reply-${k}`,
        type: 'text',
        body: 'Hola, te paso el precio',
        delivery: { state: 'queued', reason: null },
      });
      expect(await outbox(id)).toEqual([
        expect.objectContaining({
          id: response.body!.id,
          sender_type: 'user',
          sent_by_user_id: users[k].id,
          idempotency_key: `panel:${idempotencyKey}`,
          body: 'Hola, te paso el precio',
          status: 'queued',
        }),
      ]);
    }
  });

  it('seller de otro número → 404; viewer → 403; otra empresa e inexistente → 404; nada en el outbox', async () => {
    const other = await createConversation(tenantA, channels.A2);
    expect((await send(clients.seller, other, { body: 'Hola', idempotencyKey: key() })).status).toBe(404);
    expect((await send(clients.seller2, other, { body: 'Hola', idempotencyKey: key() })).status).toBe(404);
    expect((await send(clients.viewer, other, { body: 'Hola', idempotencyKey: key() })).status).toBe(403);
    expect((await send(clients.ownerB, other, { body: 'Hola', idempotencyKey: key() })).status).toBe(404);
    const b = await createConversation(tenantB, channels.B1);
    expect((await send(clients.owner, b, { body: 'Hola', idempotencyKey: key() })).status).toBe(404);
    expect(
      (await send(clients.owner, crypto.randomUUID(), { body: 'Hola', idempotencyKey: key() })).status,
    ).toBe(404);
    expect(await outbox(other)).toEqual([]);
    expect(await outbox(b)).toEqual([]);
  });

  it('valida el body: vacío, solo espacios, más de 4096, clave que no es UUID y campos de más → 400', async () => {
    const id = await createConversation(tenantA, channels.A1);
    for (const body of [
      { body: '', idempotencyKey: key() },
      { body: ' \n\t ', idempotencyKey: key() },
      { body: 'a'.repeat(4097), idempotencyKey: key() },
      { body: 'Hola', idempotencyKey: 'abc' },
      { body: 'Hola' },
      { body: 'Hola', idempotencyKey: key(), senderType: 'ai' },
    ]) {
      const response = await send(clients.owner, id, body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    // 4096 caracteres (con emojis de dos unidades UTF-16) sí entra.
    const ok = await send(clients.owner, id, { body: '😀'.repeat(4096), idempotencyKey: key() });
    expect(ok.status).toBe(200);
    expect(await outbox(id)).toHaveLength(1);
  });
});

describe('2. idempotencia', () => {
  it('la misma clave dos veces (y en paralelo) → un solo envío y la misma respuesta', async () => {
    const id = await createConversation(tenantA, channels.A1);
    const idempotencyKey = key();
    const first = await send(clients.seller, id, { body: 'Hola', idempotencyKey });
    const again = await send(clients.seller, id, { body: 'Hola', idempotencyKey });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);

    const parallelKey = key();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        send(clients.seller, id, { body: 'Doble clic', idempotencyKey: parallelKey }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body!.id)).size).toBe(1);
    expect(await outbox(id)).toHaveLength(2);
  });

  it('la misma clave con otro texto → 409 IDEMPOTENCY_CONFLICT', async () => {
    const id = await createConversation(tenantA, channels.A1);
    const idempotencyKey = key();
    expect((await send(clients.owner, id, { body: 'Hola', idempotencyKey })).status).toBe(200);
    const conflict = await send(clients.owner, id, { body: 'Chau', idempotencyKey });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await outbox(id)).toHaveLength(1);
  });

  it('una clave ya usada en un número que el seller no ve → 409 (no 500) y nada de esa fila', async () => {
    const hidden = await createConversation(tenantA, channels.A2);
    const mine = await createConversation(tenantA, channels.A1);
    const idempotencyKey = key();
    expect((await send(clients.owner, hidden, { body: 'Privado', idempotencyKey })).status).toBe(200);
    const response = await send(clients.seller, mine, { body: 'Hola', idempotencyKey });
    expect(response).toEqual({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await outbox(mine)).toEqual([]);
  });

  it('repetir la clave no vuelve a correr la pausa de la IA', async () => {
    const id = await createConversation(tenantA, channels.A1);
    const idempotencyKey = key();
    await send(clients.owner, id, { body: 'Hola', idempotencyKey });
    await ctx.ownerPool.query(`UPDATE conversations SET ai_paused_until = NULL WHERE id = $1`, [id]);
    expect((await send(clients.owner, id, { body: 'Hola', idempotencyKey })).status).toBe(200);
    expect((await conversationRow(id)).ai_paused_until).toBeNull();
  });
});

describe('3. reglas de envío → 409 sin encolar nada', () => {
  it('canal pausado → CHANNEL_PAUSED, y el detalle lo explica', async () => {
    const channel = await createChannel(tenantA, users.owner.id, 'Pausado');
    const id = await createConversation(tenantA, channel);
    await ctx.ownerPool.query(
      `UPDATE channels SET sending_paused_until = 'infinity', sending_paused_reason = 'blocked_risk:463'
       WHERE id = $1`,
      [channel],
    );
    const response = await send(clients.owner, id, { body: 'Hola', idempotencyKey: key() });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CHANNEL_PAUSED' });
    expect(await outbox(id)).toEqual([]);
    expect((await conversationRow(id)).ai_paused_until).toBeNull();
    const detail = await clients.owner.get(`/api/conversations/${id}`);
    expect(detail.body!.reply).toEqual({ allowed: false, reason: 'channel_paused', pausedUntil: null });

    // Con un vencimiento, el detalle dice hasta cuándo.
    await ctx.ownerPool.query(
      `UPDATE channels SET sending_paused_until = now() + interval '2 hours' WHERE id = $1`,
      [channel],
    );
    const timed = await clients.owner.get(`/api/conversations/${id}`);
    expect(timed.body!.reply).toMatchObject({ allowed: false, reason: 'channel_paused' });
    expect(Date.parse((timed.body!.reply as { pausedUntil: string }).pausedUntil)).toBeGreaterThan(
      Date.now(),
    );
  });

  it('canal desconectado → CHANNEL_UNAVAILABLE', async () => {
    const channel = await createChannel(tenantA, users.owner.id, 'Desconectado');
    const id = await createConversation(tenantA, channel);
    await ctx.ownerPool.query(`UPDATE channels SET status = 'disconnected' WHERE id = $1`, [channel]);
    const response = await send(clients.owner, id, { body: 'Hola', idempotencyKey: key() });
    expect(response).toMatchObject({ status: 409, body: { code: 'CHANNEL_UNAVAILABLE' } });
    expect(await outbox(id)).toEqual([]);
  });

  it('sin mensajes entrantes → NO_INBOUND', async () => {
    const empty = await createConversation(tenantA, channels.A1, null);
    expect(await send(clients.owner, empty, { body: 'Hola', idempotencyKey: key() })).toMatchObject({
      status: 409,
      body: { code: 'NO_INBOUND' },
    });
    expect(await outbox(empty)).toEqual([]);
  });

  it('más de 24 h desde el último entrante: una persona responde (WAHA no exige la ventana); la IA no', async () => {
    const old = await createConversation(tenantA, channels.A1, '25 hours');
    const detail = await clients.owner.get(`/api/conversations/${old}`);
    expect(detail.body!.reply).toEqual({ allowed: true, reason: null, pausedUntil: null });
    const response = await send(clients.owner, old, { body: 'Hola', idempotencyKey: key() });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ delivery: { state: 'queued', reason: null } });
    // El worker vuelve a evaluar las reglas antes de mandar: la respuesta de la persona sale igual.
    const provider = new FakeProvider();
    const worker = new OutboundWorker(fakeBoss().boss, registryWith(provider), ctx.app.get(APP_DB), {
      sleep: async () => {},
      random: () => 0.5,
    });
    expect(await worker.handle({ outboundId: response.body!.id, tenantId: tenantA }, attempt())).toBe(
      'enviado',
    );
    expect(provider.sends()).toHaveLength(1);

    const db = ctx.app.get<AppDatabase>(APP_DB).db;
    const ai = await withTenantTransaction(db, { tenantId: tenantA }, (tx) =>
      ctx.app
        .get(OutboundService)
        .enqueueText(
          { conversationId: old, body: 'Hola', senderType: 'ai', idempotencyKey: `ai:${uid()}` },
          tx,
        ),
    );
    expect(ai).toMatchObject({ status: 'rejected', rejectReason: 'window_expired' });

    // Un proveedor que exige la ventana (la Cloud API): tampoco una persona.
    const strict = new FakeProvider();
    strict.capabilities.within24hWindowOnly = true;
    const human = await withTenantTransaction(db, { tenantId: tenantA }, (tx) =>
      new OutboundService(fakeBoss().boss, registryWith(strict)).enqueueText(
        {
          conversationId: old,
          body: 'Hola',
          senderType: 'user',
          sentByUserId: users.owner.id,
          idempotencyKey: `panel:${uid()}`,
        },
        tx,
      ),
    );
    expect(human).toMatchObject({ status: 'rejected', rejectReason: 'window_expired' });
  });

  it('una conversación donde se puede responder → reply.allowed', async () => {
    const id = await createConversation(tenantA, channels.A1);
    const detail = await clients.seller.get(`/api/conversations/${id}`);
    expect(detail.body!.reply).toEqual({ allowed: true, reason: null, pausedUntil: null });
  });
});

describe('4. la IA después de responder desde el panel', () => {
  it('pausa la IA 12 h y rechaza (superseded) sus respuestas en cola; la que ya sale, sigue', async () => {
    const id = await createConversation(tenantA, channels.A1);
    const queued = await queueAiReply(tenantA, id, channels.A1);
    const sending = await queueAiReply(tenantA, id, channels.A1, 'sending');
    expect((await send(clients.seller, id, { body: 'Te atiendo yo', idempotencyKey: key() })).status).toBe(
      200,
    );
    expect((await conversationRow(id)).paused_12h).toBe(true);
    const rows = await outbox(id);
    expect(rows.find((r) => r.id === queued)).toMatchObject({
      status: 'rejected',
      reject_reason: 'superseded',
    });
    expect(rows.find((r) => r.id === sending)).toMatchObject({ status: 'sending', reject_reason: null });

    // En la lista: la cancelada no aparece; la que sale y la del panel, sí.
    const list = await clients.seller.get(`/api/conversations/${id}/messages`);
    const items = list.body!.items as { id: string; senderType: string; delivery: unknown }[];
    expect(items.map((m) => m.id)).not.toContain(queued);
    expect(items.find((m) => m.id === sending)).toMatchObject({
      senderType: 'ai',
      delivery: { state: 'sending', reason: null },
    });
  });

  it('una pausa más larga que ya existía no se acorta', async () => {
    const id = await createConversation(tenantA, channels.A1);
    await ctx.ownerPool.query(
      `UPDATE conversations SET ai_paused_until = now() + interval '3 days' WHERE id = $1`,
      [id],
    );
    await send(clients.owner, id, { body: 'Hola', idempotencyKey: key() });
    const { rows } = await ctx.ownerPool.query(
      `SELECT ai_paused_until > now() + interval '2 days' AS kept FROM conversations WHERE id = $1`,
      [id],
    );
    expect(rows[0].kept).toBe(true);
  });
});

describe('5. estado de cada mensaje', () => {
  it('une messages y el outbox, con el estado y solo códigos (nunca el error del proveedor)', async () => {
    const id = await createConversation(tenantA, channels.A1);
    const sent = await send(clients.owner, id, { body: 'En cola', idempotencyKey: key() });
    await withTenant(ctx, tenantA, async (c) => {
      for (const [status, n] of [
        ['sent', 1],
        ['delivered', 2],
        ['read', 3],
        ['failed', 4],
      ] as const) {
        await c.query(
          `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
             type, body, status, raw, sent_at)
           VALUES ($1, $2, $3, $4, 'outbound', 'ai', 'text', $5, $6, '{}'::jsonb, now() - make_interval(mins => 50 - $7))`,
          [tenantA, id, channels.A1, `true_${uid()}`, status, status, n],
        );
      }
    });
    await ctx.ownerPool.query(
      `INSERT INTO outbound_messages (tenant_id, conversation_id, channel_id, idempotency_key, sender_type,
         sent_by_user_id, body, status, last_error, reject_reason, created_at)
       VALUES ($1, $2, $3, $4, 'user', $5, 'No salió', 'failed', 'invalid_recipient', NULL,
               now() - interval '5 minutes'),
              ($1, $2, $3, $6, 'user', $5, 'Quizás salió', 'failed', 'unknown_outcome', NULL,
               now() - interval '4 minutes'),
              ($1, $2, $3, $7, 'ai', NULL, 'Rechazada', 'rejected', NULL, 'window_expired',
               now() - interval '3 minutes')`,
      [tenantA, id, channels.A1, `panel:${key()}`, users.owner.id, `panel:${key()}`, `ai:${uid()}`],
    );

    const list = await clients.owner.get(`/api/conversations/${id}/messages`);
    expect(list.status).toBe(200);
    const items = list.body!.items as Record<string, unknown>[];
    const byBody = new Map(items.map((m) => [m.body, m]));
    expect(byBody.get('Hola')).toMatchObject({ direction: 'inbound', delivery: null });
    expect(byBody.get('sent')).toMatchObject({ delivery: { state: 'sent', reason: null } });
    expect(byBody.get('delivered')).toMatchObject({ delivery: { state: 'delivered', reason: null } });
    expect(byBody.get('read')).toMatchObject({ delivery: { state: 'read', reason: null } });
    expect(byBody.get('failed')).toMatchObject({ delivery: { state: 'failed', reason: 'not_sent' } });
    expect(byBody.get('No salió')).toMatchObject({
      senderType: 'user',
      sentByName: 'reply-owner',
      delivery: { state: 'failed', reason: 'not_sent' },
    });
    expect(byBody.get('Quizás salió')).toMatchObject({ delivery: { state: 'failed', reason: 'maybe_sent' } });
    expect(byBody.get('Rechazada')).toMatchObject({
      delivery: { state: 'rejected', reason: 'window_expired' },
    });
    expect(byBody.get('En cola')).toMatchObject({
      id: sent.body!.id,
      delivery: { state: 'queued', reason: null },
    });
    // Orden por fecha; el de la cola (el más nuevo) al final. Ninguna clave de más.
    expect(items.at(-1)!.body).toBe('En cola');
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        ['body', 'delivery', 'direction', 'id', 'senderType', 'sentAt', 'sentByName', 'type'].sort(),
      );
    }
    expect(JSON.stringify(items)).not.toMatch(/invalid_recipient|unknown_outcome|idempotency|panel:/);
  });

  it('cuando sale, el mensaje del outbox se ve una sola vez (el de messages)', async () => {
    const id = await createConversation(tenantA, channels.A1);
    const sent = await send(clients.owner, id, { body: 'Una vez', idempotencyKey: key() });
    // Lo que hace el worker al enviar (recordSent): mensaje + message_id en el outbox.
    await withTenant(ctx, tenantA, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
           sent_by_user_id, type, body, status, raw, sent_at)
         VALUES ($1, $2, $3, $4, 'outbound', 'user', $5, 'text', 'Una vez', 'sent', '{}'::jsonb, now())
         RETURNING id`,
        [tenantA, id, channels.A1, `true_${uid()}`, users.owner.id],
      );
      await c.query(
        `UPDATE outbound_messages SET status = 'sent', external_id = 'x', message_id = $2 WHERE id = $1`,
        [sent.body!.id, rows[0]!.id],
      );
    });
    const list = await clients.owner.get(`/api/conversations/${id}/messages`);
    const items = (list.body!.items as { body: string; delivery: unknown }[]).filter(
      (m) => m.body === 'Una vez',
    );
    expect(items).toEqual([expect.objectContaining({ delivery: { state: 'sent', reason: null } })]);
  });

  it('el cursor sigue paginando con los dos orígenes mezclados', async () => {
    const id = await createConversation(tenantA, channels.A1);
    for (let i = 0; i < 3; i++) await send(clients.owner, id, { body: `Cola ${i}`, idempotencyKey: key() });
    const first = await clients.owner.get(`/api/conversations/${id}/messages?limit=2`);
    expect((first.body!.items as { body: string }[]).map((m) => m.body)).toEqual(['Cola 1', 'Cola 2']);
    const second = await clients.owner.get(
      `/api/conversations/${id}/messages?limit=2&before=${first.body!.nextBefore as string}`,
    );
    expect((second.body!.items as { body: string }[]).map((m) => m.body)).toEqual(['Hola', 'Cola 0']);
    expect(second.body!.nextBefore).toBeNull();
  });
});

describe('6. "sin responder" y derivadas sin atender', () => {
  it('apenas se encola, deja de esperar respuesta y la derivada deja de estar sin atender', async () => {
    const id = await createConversation(tenantA, channels.A1);
    await ctx.ownerPool.query(
      `UPDATE conversations SET handed_off_at = now(), handoff_reason = 'asks_human' WHERE id = $1`,
      [id],
    );
    const row = async () => {
      const response = await clients.owner.get(`/api/leads?pageSize=50&sort=last_message`);
      return (response.body!.items as { id: string; awaitingReply: boolean; pendingHandoff: boolean }[]).find(
        (item) => item.id === id,
      );
    };
    expect(await row()).toMatchObject({ awaitingReply: true, pendingHandoff: true });
    await send(clients.owner, id, { body: 'Te atiendo', idempotencyKey: key() });
    expect(await row()).toMatchObject({ awaitingReply: false, pendingHandoff: false });

    // Si el envío falla, vuelve a esperar respuesta.
    await ctx.ownerPool.query(
      `UPDATE outbound_messages SET status = 'failed', last_error = 'invalid_recipient' WHERE conversation_id = $1`,
      [id],
    );
    expect(await row()).toMatchObject({ awaitingReply: true, pendingHandoff: true });
  });
});
