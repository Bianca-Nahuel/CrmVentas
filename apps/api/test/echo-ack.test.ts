// Verificación de la tarea 005 (ecos y acuses): un eco propio no se duplica ni pausa la IA (antes y
// después de que vuelva sendText), uno escrito desde el teléfono sí la pausa, y los acuses nunca
// retroceden. Contra el Postgres local, con el worker de entrada real y la cola falsa. Números ficticios.
import { readFileSync } from 'node:fs';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_DB, type AppDatabase } from '../src/db/database.module.js';
import { withTenantTransaction } from '../src/db/tenant-context.js';
import { BOSS, QUEUES } from '../src/jobs/jobs.module.js';
import { ECHO_RECHECK_MAX } from '../src/messaging/outbound/outbound.constants.js';
import { OutboundService } from '../src/messaging/outbound/outbound.service.js';
import { OutboundWorker } from '../src/messaging/outbound/outbound.worker.js';
import { InboundService } from '../src/whatsapp/inbound/inbound.service.js';
import { InboundWorker } from '../src/whatsapp/inbound/inbound.worker.js';
import { startTestContext, type TestContext } from './helpers.js';
import {
  attempt,
  createChannelTenant,
  createChat,
  fakeBoss,
  FakeProvider,
  registryWith,
  uid,
  type Chat,
} from './outbound-helpers.js';

let ctx: TestContext;
let db: AppDatabase;

interface Envelope {
  id: string;
  session: string;
  event: string;
  payload: Record<string, unknown>;
}

function fixture(name: string): Envelope {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/whatsapp/waha/${name}.json`, import.meta.url), 'utf8'),
  ) as Envelope;
}

/** message.any propio (fromMe) en el chat, con el id de WhatsApp `key`. */
function echoEvent(chat: Pick<Chat, 'session' | 'phoneDigits'>, key: string, body: string): Envelope {
  const base = fixture('message-from-me');
  const from = `${chat.phoneDigits}@c.us`;
  return {
    ...base,
    id: `evt_${uid()}`,
    event: 'message.any',
    session: chat.session,
    payload: {
      ...base.payload,
      id: `true_${from}_${key}`,
      from,
      body,
      timestamp: Math.floor(Date.now() / 1000),
    },
  };
}

function ackEvent(chat: Chat, key: string, ack: number, fromMe = true): Envelope {
  const base = fixture('message-ack-read');
  const from = `${chat.phoneDigits}@c.us`;
  return {
    ...base,
    id: `evt_${uid()}`,
    session: chat.session,
    payload: { ...base.payload, id: `${fromMe}_${from}_${key}`, from, fromMe, ack },
  };
}

const newKey = () => uid().toUpperCase();

/** Worker de entrada real con una cola falsa (para ver las reprogramaciones de los ecos). */
function inbound() {
  const { boss, sent } = fakeBoss();
  const provider = new FakeProvider();
  const worker = new InboundWorker(boss, registryWith(provider), ctx.app.get(InboundService));
  return {
    sent,
    handle: (envelope: Envelope, echoAttempt?: number) =>
      worker.handle(
        { provider: 'waha', payload: envelope, ...(echoAttempt === undefined ? {} : { echoAttempt }) },
        attempt(),
      ),
  };
}

async function freshChat(): Promise<Chat> {
  return createChat(ctx, await createChannelTenant(ctx, uid().slice(0, 8)));
}

async function enqueue(chat: Chat, body: string) {
  return withTenantTransaction(db.db, { tenantId: chat.tenantId }, (tx) =>
    ctx.app
      .get(OutboundService)
      .enqueueText(
        { conversationId: chat.conversationId, body, senderType: 'ai', idempotencyKey: uid() },
        tx,
      ),
  );
}

async function conversationState(conversationId: string) {
  const { rows } = await ctx.ownerPool.query<{ ai_paused_until: Date | null; last_inbound_at: Date | null }>(
    'SELECT ai_paused_until, last_inbound_at FROM conversations WHERE id = $1',
    [conversationId],
  );
  return rows[0]!;
}

async function messagesOf(conversationId: string) {
  const { rows } = await ctx.ownerPool.query(
    `SELECT external_id, direction, sender_type, sent_by_user_id, body, status
     FROM messages WHERE conversation_id = $1 ORDER BY created_at`,
    [conversationId],
  );
  return rows;
}

beforeAll(async () => {
  ctx = await startTestContext();
  await ctx.app.get<PgBoss>(BOSS).offWork(QUEUES.whatsappOutbound);
  db = ctx.app.get<AppDatabase>(APP_DB);
});

afterAll(async () => {
  await ctx?.close();
});

describe('6. eco de un mensaje propio', () => {
  it('antes de que vuelva sendText → se reprograma; después → duplicado; nunca pausa la IA', async () => {
    const chat = await freshChat();
    const body = 'Sí, lo tenemos en 60x60';
    const { outboundId } = await enqueue(chat, body);
    const key = newKey();
    const echoes = inbound();

    const provider = new FakeProvider();
    provider.sendResult = () => ({ ok: true, externalId: `true_${key}`, sentAt: new Date().toISOString() });
    // El eco llega mientras sendText todavía no volvió (la fila está en 'sending').
    provider.duringSend = () => echoes.handle(echoEvent(chat, key, body));
    const { boss } = fakeBoss();
    const worker = new OutboundWorker(boss, registryWith(provider), db, {
      sleep: async () => {},
      random: () => 0.5,
    });
    expect(await worker.handle({ outboundId, tenantId: chat.tenantId }, attempt())).toBe('enviado');

    expect(echoes.sent).toHaveLength(1);
    expect(echoes.sent[0]).toMatchObject({
      name: QUEUES.whatsappInbound,
      data: { echoAttempt: 1 },
      options: { startAfter: 5 },
    });
    // Vuelve a mirar el mismo eco (ya terminó el envío) y llega otro reenvío del webhook.
    await echoes.handle(echoEvent(chat, key, body), 1);
    await echoes.handle(echoEvent(chat, key, body));

    const rows = await messagesOf(chat.conversationId);
    expect(rows).toEqual([
      expect.objectContaining({ external_id: `true_${key}`, direction: 'outbound', sender_type: 'ai', body }),
    ]);
    expect((await conversationState(chat.conversationId)).ai_paused_until).toBeNull();
  });

  it('eco que coincide con un envío unknown_outcome → se confirma (sent) y, por las dudas, pausa', async () => {
    const chat = await freshChat();
    const body = 'Te lo reservo';
    const { outboundId } = await enqueue(chat, body);
    await ctx.ownerPool.query(
      `UPDATE outbound_messages SET status = 'failed', last_error = 'unknown_outcome', claimed_at = now(),
         attempts = 1 WHERE id = $1`,
      [outboundId],
    );
    const key = newKey();
    await inbound().handle(echoEvent(chat, key, body));
    const { rows } = await ctx.ownerPool.query(
      'SELECT status, external_id, message_id, last_error FROM outbound_messages WHERE id = $1',
      [outboundId],
    );
    expect(rows[0]).toMatchObject({ status: 'sent', external_id: `true_${key}`, last_error: null });
    expect(rows[0].message_id).not.toBeNull();
    expect(await messagesOf(chat.conversationId)).toEqual([
      expect.objectContaining({ external_id: `true_${key}`, sender_type: 'ai' }),
    ]);
    // Podría ser una persona que escribió el mismo texto: la IA no le responde encima.
    expect((await conversationState(chat.conversationId)).ai_paused_until).not.toBeNull();
  });

  it('el mismo texto que un envío ya sent (con otro id) NO se reconcilia: es de una persona', async () => {
    const chat = await freshChat();
    const body = 'Gracias!';
    const { outboundId } = await enqueue(chat, body);
    const provider = new FakeProvider();
    const { boss } = fakeBoss();
    await new OutboundWorker(boss, registryWith(provider), db, {
      sleep: async () => {},
      random: () => 0.5,
    }).handle({ outboundId, tenantId: chat.tenantId }, attempt());
    await inbound().handle(echoEvent(chat, newKey(), body));
    const senders = (await messagesOf(chat.conversationId)).map((row) => row.sender_type);
    expect(senders).toEqual(['ai', 'user']);
    expect((await conversationState(chat.conversationId)).ai_paused_until).not.toBeNull();
  });

  it(`envío trabado en sending: después de ${ECHO_RECHECK_MAX} reintentos el eco se trata como de una persona`, async () => {
    const chat = await freshChat();
    const { outboundId } = await enqueue(chat, 'algo');
    await ctx.ownerPool.query(
      "UPDATE outbound_messages SET status = 'sending', claimed_at = now() WHERE id = $1",
      [outboundId],
    );
    const echoes = inbound();
    await echoes.handle(echoEvent(chat, newKey(), 'otra cosa'), ECHO_RECHECK_MAX - 1);
    expect(echoes.sent).toHaveLength(1);
    expect(await messagesOf(chat.conversationId)).toHaveLength(0);
    await echoes.handle(echoEvent(chat, newKey(), 'otra cosa'), ECHO_RECHECK_MAX);
    expect(echoes.sent).toHaveLength(1);
    expect((await messagesOf(chat.conversationId)).map((row) => row.sender_type)).toEqual(['user']);
  });
});

describe('7. eco escrito desde el teléfono', () => {
  it("se guarda como 'user' sin usuario y pausa la IA ~12 h; logs sin texto ni teléfono", async () => {
    const chat = await freshChat();
    const body = 'Hola, soy Juan del local, te llamo en un rato';
    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await inbound().handle(echoEvent(chat, newKey(), body));
    } finally {
      spy.mockRestore();
    }
    expect(await messagesOf(chat.conversationId)).toEqual([
      expect.objectContaining({ direction: 'outbound', sender_type: 'user', sent_by_user_id: null, body }),
    ]);
    const paused = (await conversationState(chat.conversationId)).ai_paused_until!;
    expect(paused.getTime()).toBeGreaterThan(Date.now() + 11.9 * 3_600_000);
    expect(paused.getTime()).toBeLessThan(Date.now() + 12.1 * 3_600_000);

    // 11. Logs.
    const logs = output.join('');
    expect(logs).toContain('pausado');
    expect(logs).not.toContain(body);
    expect(logs).not.toContain(chat.phoneDigits);
  });

  it('un chat sin conversación (la persona escribió primero) → contacto y conversación nuevos, pausados', async () => {
    const channel = await createChannelTenant(ctx, uid().slice(0, 8));
    const phoneDigits = `54911${String(Date.now()).slice(-8)}`;
    await inbound().handle(
      echoEvent({ session: channel.session, phoneDigits }, newKey(), 'Hola! te escribo por el pedido'),
    );
    const { rows } = await ctx.ownerPool.query(
      `SELECT cv.ai_paused_until, cv.last_inbound_at, ct.profile_name
       FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
       WHERE cv.channel_id = $1 AND ct.wa_id = $2`,
      [channel.channelId, `+${phoneDigits}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ai_paused_until).not.toBeNull();
    // Sin entrantes: tampoco se le puede mandar nada (no se inicia la conversación).
    expect(rows[0].last_inbound_at).toBeNull();
    // El pushName del eco es el del negocio: no se le atribuye al contacto.
    expect(rows[0].profile_name).toBeNull();
  });
});

describe('8. acuses', () => {
  async function sentMessage(chat: Chat, key: string) {
    const provider = new FakeProvider();
    provider.sendResult = () => ({ ok: true, externalId: `true_${key}`, sentAt: new Date().toISOString() });
    const { outboundId } = await enqueue(chat, 'Te paso el precio');
    const { boss } = fakeBoss();
    await new OutboundWorker(boss, registryWith(provider), db, {
      sleep: async () => {},
      random: () => 0.5,
    }).handle({ outboundId, tenantId: chat.tenantId }, attempt());
  }

  async function statusOf(chat: Chat, externalId: string) {
    const { rows } = await ctx.ownerPool.query(
      'SELECT status FROM messages WHERE channel_id = $1 AND external_id = $2',
      [chat.channelId, externalId],
    );
    return rows[0]?.status;
  }

  it('sent → delivered → read; un delivered o failed tardío no lo hace retroceder', async () => {
    const chat = await freshChat();
    const key = newKey();
    await sentMessage(chat, key);
    const acks = inbound();
    expect(await statusOf(chat, `true_${key}`)).toBe('sent');
    await acks.handle(ackEvent(chat, key, 2));
    expect(await statusOf(chat, `true_${key}`)).toBe('delivered');
    await acks.handle(ackEvent(chat, key, 3));
    expect(await statusOf(chat, `true_${key}`)).toBe('read');
    await acks.handle(ackEvent(chat, key, 2));
    await acks.handle(ackEvent(chat, key, -1));
    await acks.handle(ackEvent(chat, key, 1));
    expect(await statusOf(chat, `true_${key}`)).toBe('read');
  });

  it('ack de un mensaje que no existe → ignorado (sin error ni reintento)', async () => {
    const chat = await freshChat();
    const acks = inbound();
    await expect(acks.handle(ackEvent(chat, newKey(), 3))).resolves.toBeUndefined();
    expect(acks.sent).toHaveLength(0);
  });

  it('el ack READ que genera nuestro "visto" sobre un entrante no cambia el entrante', async () => {
    const chat = await freshChat();
    const key = newKey();
    await ctx.ownerPool.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type, type,
         body, status, raw, sent_at)
       VALUES ($1, $2, $3, $4, 'inbound', 'contact', 'text', 'hola', 'received', '{}', now())`,
      [chat.tenantId, chat.conversationId, chat.channelId, `false_${key}`],
    );
    await inbound().handle(ackEvent(chat, key, 3, false));
    expect(await statusOf(chat, `false_${key}`)).toBe('received');
  });
});

describe('9. aislamiento de ecos y acuses', () => {
  it('un eco o un ack del canal de A nunca toca filas de B, aunque el id coincida', async () => {
    const chatA = await freshChat();
    const chatB = await freshChat();
    const key = newKey();
    // En B hay un mensaje enviado con ese id.
    await ctx.ownerPool.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type, type,
         body, status, raw, sent_at)
       VALUES ($1, $2, $3, $4, 'outbound', 'ai', 'text', 'de B', 'sent', '{}', now())`,
      [chatB.tenantId, chatB.conversationId, chatB.channelId, `true_${key}`],
    );
    const handler = inbound();
    // Mismo número de contacto que en B, pero llega por la sesión de A.
    await handler.handle(echoEvent({ session: chatA.session, phoneDigits: chatB.phoneDigits }, key, 'de A'));
    await handler.handle(ackEvent({ ...chatB, session: chatA.session }, key, 3));

    const { rows } = await ctx.ownerPool.query(
      'SELECT tenant_id, status, body FROM messages WHERE external_id = $1 ORDER BY body',
      [`true_${key}`],
    );
    expect(rows).toEqual([
      { tenant_id: chatA.tenantId, status: 'read', body: 'de A' },
      { tenant_id: chatB.tenantId, status: 'sent', body: 'de B' },
    ]);
    expect((await conversationState(chatB.conversationId)).ai_paused_until).toBeNull();
  });
});
