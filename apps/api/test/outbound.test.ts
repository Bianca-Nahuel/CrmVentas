// Verificación de la tarea 005 (envío): OutboundService (idempotencia y reglas), worker de envío
// (secuencia, sin envíos en paralelo, sin reenvíos, límites, errores), aislamiento, permisos y logs.
// Contra el Postgres local; el proveedor y las reprogramaciones son falsos. Números ficticios.
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_DB, type AppDatabase } from '../src/db/database.module.js';
import { withTenantTransaction } from '../src/db/tenant-context.js';
import { BOSS, QUEUES } from '../src/jobs/jobs.module.js';
import {
  ConversationNotFoundError,
  IdempotencyConflictError,
  OutboundService,
  type EnqueueTextInput,
  type OutboundJob,
} from '../src/messaging/outbound/outbound.service.js';
import { WORST_CASE_SEND_MS } from '../src/messaging/outbound/outbound.constants.js';
import { OutboundWorker } from '../src/messaging/outbound/outbound.worker.js';
import { addMessage } from './ai-helpers.js';
import { asApp, errorCodeIn, startTestContext, type TestContext } from './helpers.js';
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
let service: OutboundService;
type ChannelTenant = Awaited<ReturnType<typeof createChannelTenant>>;
let a: ChannelTenant;
let b: ChannelTenant;

const TEXT = 'Hola, el porcelanato 60x60 está en stock';

beforeAll(async () => {
  ctx = await startTestContext();
  // El worker real de la app no toma los envíos de estos tests: los procesa un worker con proveedor falso.
  await ctx.app.get<PgBoss>(BOSS).offWork(QUEUES.whatsappOutbound);
  db = ctx.app.get<AppDatabase>(APP_DB);
  service = ctx.app.get(OutboundService);
  a = await createChannelTenant(ctx, 'a');
  b = await createChannelTenant(ctx, 'b');
});

afterAll(async () => {
  await ctx?.close();
});

function enqueue(chat: Chat, input: Partial<EnqueueTextInput> = {}, tenantId = chat.tenantId) {
  return withTenantTransaction(db.db, { tenantId }, (tx) =>
    service.enqueueText(
      {
        conversationId: chat.conversationId,
        body: TEXT,
        senderType: 'app',
        idempotencyKey: uid(),
        ...input,
      },
      tx,
    ),
  );
}

// Cada test que envía usa un canal propio: el límite por canal cuenta los envíos del último minuto.
async function freshChat(): Promise<Chat> {
  return createChat(ctx, await createChannelTenant(ctx, uid().slice(0, 8)));
}

function workerWith(provider: FakeProvider) {
  const { boss, sent } = fakeBoss();
  const worker = new OutboundWorker(boss, registryWith(provider), db, {
    sleep: async () => {},
    random: () => 0.5,
  });
  return { worker, sent };
}

const job = (chat: Chat, outboundId: string) => ({ outboundId, tenantId: chat.tenantId });

async function outbox(id: string) {
  const { rows } = await ctx.ownerPool.query(
    `SELECT status, reject_reason, attempts, last_error, external_id, message_id, claimed_at
     FROM outbound_messages WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function channelRow(channelId: string) {
  const { rows } = await ctx.ownerPool.query(
    `SELECT status, sending_paused_until, sending_paused_reason FROM channels WHERE id = $1`,
    [channelId],
  );
  return rows[0];
}

async function jobsOf(outboundId: string) {
  const { rows } = await ctx.ownerPool.query<{ singleton_key: string; state: string }>(
    `SELECT singleton_key, state FROM pgboss.job WHERE name = $1 AND data->>'outboundId' = $2`,
    [QUEUES.whatsappOutbound, outboundId],
  );
  return rows;
}

describe('1. idempotencia', () => {
  it('misma clave dos veces → 1 fila, 1 trabajo y 1 envío', async () => {
    const chat = await freshChat();
    const idempotencyKey = uid();
    const first = await enqueue(chat, { idempotencyKey });
    const second = await enqueue(chat, { idempotencyKey });
    expect(first).toMatchObject({ status: 'queued', created: true });
    expect(second).toEqual({ ...first, created: false });

    const { rows } = await ctx.ownerPool.query(
      'SELECT count(*)::int AS n FROM outbound_messages WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    expect(rows[0].n).toBe(1);
    const jobs = await jobsOf(first.outboundId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.singleton_key).toBe(chat.conversationId);

    const provider = new FakeProvider();
    const { worker } = workerWith(provider);
    expect(await worker.handle(job(chat, first.outboundId), attempt())).toBe('enviado');
    expect(await worker.handle(job(chat, first.outboundId), attempt())).toBe('sin_cambios');
    expect(provider.sends()).toHaveLength(1);
  });

  it('misma clave con otro texto o conversación → IdempotencyConflictError', async () => {
    const chat = await freshChat();
    const other = await freshChat();
    const idempotencyKey = uid();
    await enqueue(chat, { idempotencyKey });
    await expect(enqueue(chat, { idempotencyKey, body: 'otro texto' })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expect(
      enqueue(chat, { idempotencyKey, conversationId: other.conversationId }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('una clave rechazada queda rechazada aunque cambien las reglas', async () => {
    const chat = await createChat(ctx, a, { lastInboundAgo: null });
    const idempotencyKey = uid();
    expect(await enqueue(chat, { idempotencyKey })).toMatchObject({
      status: 'rejected',
      rejectReason: 'no_inbound',
    });
    await ctx.ownerPool.query('UPDATE conversations SET last_inbound_at = now() WHERE id = $1', [
      chat.conversationId,
    ]);
    expect(await enqueue(chat, { idempotencyKey })).toMatchObject({
      status: 'rejected',
      rejectReason: 'no_inbound',
      created: false,
    });
  });
});

describe('2. reglas antes de encolar', () => {
  it('sin entrantes, ventana vencida y contacto bloqueado → rejected, sin trabajo en la cola', async () => {
    const cases: [Chat, string][] = [
      [await createChat(ctx, a, { lastInboundAgo: null }), 'no_inbound'],
      [await createChat(ctx, a, { lastInboundAgo: '25 hours' }), 'window_expired'],
      [await createChat(ctx, a, { blocked: true }), 'contact_blocked'],
    ];
    for (const [chat, reason] of cases) {
      const result = await enqueue(chat);
      expect(result).toMatchObject({ status: 'rejected', rejectReason: reason });
      expect(await outbox(result.outboundId)).toMatchObject({ status: 'rejected', reject_reason: reason });
      expect(await jobsOf(result.outboundId)).toHaveLength(0);
    }
  });

  it('canal pausado o desconectado → rejected', async () => {
    const paused = await createChannelTenant(ctx, 'paused');
    const pausedChat = await createChat(ctx, paused);
    await ctx.ownerPool.query(
      "UPDATE channels SET sending_paused_until = 'infinity', sending_paused_reason = 'blocked_risk:waha_463' WHERE id = $1",
      [paused.channelId],
    );
    expect(await enqueue(pausedChat)).toMatchObject({ status: 'rejected', rejectReason: 'channel_paused' });

    const down = await createChannelTenant(ctx, 'down');
    const downChat = await createChat(ctx, down);
    await ctx.ownerPool.query("UPDATE channels SET status = 'disconnected' WHERE id = $1", [down.channelId]);
    expect(await enqueue(downChat)).toMatchObject({
      status: 'rejected',
      rejectReason: 'channel_unavailable',
    });
  });

  it('el worker vuelve a chequear las reglas: contacto bloqueado mientras esperaba → rejected sin enviar', async () => {
    const chat = await freshChat();
    const { outboundId } = await enqueue(chat);
    await ctx.ownerPool.query('UPDATE contacts SET blocked = true WHERE id = $1', [chat.contactId]);
    const provider = new FakeProvider();
    expect(await workerWith(provider).worker.handle(job(chat, outboundId), attempt())).toBe('rechazado');
    expect(await outbox(outboundId)).toMatchObject({ status: 'rejected', reject_reason: 'contact_blocked' });
    expect(provider.calls).toHaveLength(0);
  });
});

describe('3. envío correcto', () => {
  it('visto → escribiendo → dejar de escribir → enviar; messages con sender_type y outbox sent enlazado', async () => {
    const chat = await freshChat();
    // Historial: un entrante viejo, un saliente y dos entrantes nuevos (los únicos sin leer).
    const key = uid().toUpperCase();
    await ctx.ownerPool.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type, type,
         body, status, raw, sent_at)
       SELECT $1, $2, $3, v.external_id, v.direction, v.sender_type, 'text', 'x', v.status, '{}',
              now() - v.ago::interval
       FROM (VALUES ('false_OLD' || $4, 'inbound', 'contact', 'received', '55 minutes'),
                    ('true_OUT' || $4, 'outbound', 'ai', 'read', '50 minutes'),
                    ('false_NEW1' || $4, 'inbound', 'contact', 'received', '10 minutes'),
                    ('false_NEW2' || $4, 'inbound', 'contact', 'received', '5 minutes'))
         AS v(external_id, direction, sender_type, status, ago)`,
      [chat.tenantId, chat.conversationId, chat.channelId, key],
    );
    const { outboundId } = await enqueue(chat, { senderType: 'ai' });
    const provider = new FakeProvider();
    provider.sendResult = () => ({
      ok: true,
      externalId: 'true_3EB0ORDEN',
      sentAt: new Date().toISOString(),
    });
    const sleeps: number[] = [];
    const { boss } = fakeBoss();
    const worker = new OutboundWorker(boss, registryWith(provider), db, {
      sleep: async (ms) => {
        sleeps.push(ms);
        provider.calls.push({ method: 'sleep' as never, target: { channelExternalId: '', waId: '' } });
      },
      random: () => 0.5,
    });

    const output: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      expect(await worker.handle(job(chat, outboundId), attempt())).toBe('enviado');
    } finally {
      spy.mockRestore();
    }

    expect(provider.calls.map((call) => call.method)).toEqual([
      'markSeen',
      'startTyping',
      'sleep',
      'stopTyping',
      'sendText',
    ]);
    const target = { channelExternalId: chat.session, waId: chat.waId };
    expect(provider.calls[0]!.target).toEqual(target);
    // El visto lleva los entrantes posteriores al último saliente, en orden.
    expect(provider.calls[0]!.seen).toEqual([`false_NEW1${key}`, `false_NEW2${key}`]);
    expect(provider.sends()[0]).toMatchObject({ target, text: TEXT });
    // 1500 + 60 × 40 caracteres = 3900 ms (random 0.5 → sin variación), dentro de [2000, 8000].
    expect(sleeps).toEqual([3900]);

    const row = await outbox(outboundId);
    expect(row).toMatchObject({
      status: 'sent',
      external_id: 'true_3EB0ORDEN',
      attempts: 1,
      last_error: null,
    });
    const { rows } = await ctx.ownerPool.query(
      `SELECT id, direction, sender_type, sent_by_user_id, body, status, raw FROM messages WHERE id = $1`,
      [row.message_id],
    );
    expect(rows[0]).toMatchObject({
      direction: 'outbound',
      sender_type: 'ai',
      sent_by_user_id: null,
      body: TEXT,
      status: 'sent',
      raw: { source: 'outbound', outboundId },
    });

    // 11. Logs sin texto ni teléfonos.
    const logs = output.join('');
    expect(logs).toContain(outboundId);
    expect(logs).not.toContain(TEXT);
    expect(logs).not.toContain(chat.phoneDigits);
  });

  it('con typingSince descuenta de la demora el tiempo que el chat ya estuvo escribiendo', async () => {
    const sleepsFor = async (typingSince: Date | undefined, retryCount = 0) => {
      const chat = await freshChat();
      const { outboundId } = await enqueue(chat, { senderType: 'ai', typingSince });
      const provider = new FakeProvider();
      const sleeps: number[] = [];
      const { boss } = fakeBoss();
      const worker = new OutboundWorker(boss, registryWith(provider), db, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
      });
      const { rows } = await ctx.ownerPool.query<{ data: OutboundJob }>(
        `SELECT data FROM pgboss.job WHERE name = $1 AND data->>'outboundId' = $2`,
        [QUEUES.whatsappOutbound, outboundId],
      );
      expect(await worker.handle(rows[0]!.data, attempt(uid(), retryCount))).toBe('enviado');
      // El visto y el escribiendo se repiten igual (el indicador vence solo).
      expect(provider.calls.map((call) => call.method)).toEqual([
        'markSeen',
        'startTyping',
        'stopTyping',
        'sendText',
      ]);
      return sleeps;
    };
    // La demora de este texto es 3900 ms.
    expect(await sleepsFor(undefined)).toEqual([3900]);
    // Hace 2 s: queda menos de 1900 ms (también se descuenta lo que tarda en prepararse el chat del test).
    const [partial] = await sleepsFor(new Date(Date.now() - 2_000));
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThanOrEqual(1_900);
    expect(await sleepsFor(new Date(Date.now() - 6_000))).toEqual([0]);
    // El indicador ya venció (más de 20 s), o es un reintento: la demora completa.
    expect(await sleepsFor(new Date(Date.now() - 30_000))).toEqual([3900]);
    expect(await sleepsFor(new Date(Date.now() - 3_000), 1)).toEqual([3900]);
  });

  it('al reprogramar por la separación del chat, el trabajo nuevo no arrastra typingSince', async () => {
    const chat = await freshChat();
    const first = await enqueue(chat, { senderType: 'ai' });
    const { worker: firstWorker } = workerWith(new FakeProvider());
    expect(await firstWorker.handle(job(chat, first.outboundId), attempt())).toBe('enviado');

    const second = await enqueue(chat, { senderType: 'ai', typingSince: new Date() });
    const { worker, sent } = workerWith(new FakeProvider());
    const { rows } = await ctx.ownerPool.query<{ data: OutboundJob }>(
      `SELECT data FROM pgboss.job WHERE name = $1 AND data->>'outboundId' = $2`,
      [QUEUES.whatsappOutbound, second.outboundId],
    );
    expect(rows[0]!.data.typingSince).toBeDefined();
    expect(await worker.handle(rows[0]!.data, attempt())).toBe('reprogramado');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({ outboundId: second.outboundId });
    expect(sent[0]!.data).not.toHaveProperty('typingSince');
  });

  it('si fallan visto o escribiendo (salvo sesión caída), igual se envía', async () => {
    const chat = await freshChat();
    const { outboundId } = await enqueue(chat);
    const provider = new FakeProvider();
    provider.presence = { ok: false, error: 'unknown_outcome', code: 'TimeoutError' };
    expect(await workerWith(provider).worker.handle(job(chat, outboundId), attempt())).toBe('enviado');
    expect(provider.sends()).toHaveLength(1);
  });
});

describe('4. nunca dos envíos al mismo chat ni dos veces el mismo', () => {
  it('dos envíos del mismo chat procesados a la vez → nunca en paralelo, uno se reprograma', async () => {
    const chat = await freshChat();
    const first = await enqueue(chat, { body: 'primero' });
    const second = await enqueue(chat, { body: 'segundo' });
    const provider = new FakeProvider();
    provider.sendDelayMs = 300;
    const { worker, sent } = workerWith(provider);
    const results = await Promise.all([
      worker.handle(job(chat, first.outboundId), attempt()),
      worker.handle(job(chat, second.outboundId), attempt()),
    ]);
    expect(results.sort()).toEqual(['enviado', 'reprogramado']);
    expect(provider.sends()).toHaveLength(1);
    expect(provider.maxInFlight).toBe(1);
    // La reprogramación conserva la clave de la cola (un trabajo activo por chat).
    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toMatchObject({ singletonKey: chat.conversationId });
  });

  it('la cola de envíos tiene la policy singleton', async () => {
    const { rows } = await ctx.ownerPool.query('SELECT policy FROM pgboss.queue WHERE name = $1', [
      QUEUES.whatsappOutbound,
    ]);
    expect(rows[0].policy).toBe('singleton');
  });

  it('el peor caso de un envío entra en el expireInSeconds de la cola (con margen para las transacciones)', async () => {
    const { rows } = await ctx.ownerPool.query<{ expire_seconds: number }>(
      'SELECT expire_seconds FROM pgboss.queue WHERE name = $1',
      [QUEUES.whatsappOutbound],
    );
    expect(WORST_CASE_SEND_MS + 5_000).toBeLessThan(rows[0]!.expire_seconds * 1000);
  });

  it('el trabajo se reintenta (o vence) después del claim, con sendText en curso → 1 solo envío', async () => {
    const chat = await freshChat();
    const { outboundId } = await enqueue(chat);
    const provider = new FakeProvider();
    const { worker } = workerWith(provider);
    let retried: string | undefined;
    provider.duringSend = async () => {
      provider.duringSend = null;
      retried = await worker.handle(job(chat, outboundId), attempt(uid(), 1));
    };
    expect(await worker.handle(job(chat, outboundId), attempt())).toBe('enviado');
    expect(retried).toBe('reprogramado');
    expect(provider.sends()).toHaveLength(1);
  });

  it('fila propia en sending (el intento anterior se cayó después de sendText) → no reenvía', async () => {
    const chat = await freshChat();
    const { outboundId } = await enqueue(chat);
    await ctx.ownerPool.query(
      "UPDATE outbound_messages SET status = 'sending', claimed_at = now(), attempts = 1 WHERE id = $1",
      [outboundId],
    );
    const provider = new FakeProvider();
    const { worker, sent } = workerWith(provider);
    expect(await worker.handle(job(chat, outboundId), attempt())).toBe('reprogramado');
    expect(provider.calls).toHaveLength(0);
    expect(sent[0]!.options).toMatchObject({ singletonKey: chat.conversationId });

    // Pasado STUCK_SENDING_AFTER_MS se da por unknown_outcome, también sin enviar.
    await ctx.ownerPool.query(
      "UPDATE outbound_messages SET claimed_at = now() - interval '3 minutes' WHERE id = $1",
      [outboundId],
    );
    expect(await worker.handle(job(chat, outboundId), attempt())).toBe('fallido');
    expect(await outbox(outboundId)).toMatchObject({ status: 'failed', last_error: 'unknown_outcome' });
    expect(provider.calls).toHaveLength(0);
  });

  it('límite por canal: con 6 claims en el último minuto (incluidos los sending) se reprograma', async () => {
    const busy = await createChannelTenant(ctx, 'rate');
    const others = await createChat(ctx, busy);
    await ctx.ownerPool.query(
      `INSERT INTO outbound_messages (tenant_id, conversation_id, channel_id, idempotency_key, sender_type,
         body, status, claimed_at, external_id, attempts)
       SELECT $1, $2, $3, 'rate-' || n || '-' || $4, 'app', 'x',
              CASE WHEN n = 1 THEN 'sending' ELSE 'sent' END, now() - interval '10 seconds',
              CASE WHEN n = 1 THEN NULL ELSE 'true_RATE' || n || $4 END, 1
       FROM generate_series(1, 6) AS n`,
      [busy.tenantId, others.conversationId, busy.channelId, uid()],
    );
    const chat = await createChat(ctx, busy);
    const { outboundId } = await enqueue(chat);
    const provider = new FakeProvider();
    const { worker, sent } = workerWith(provider);
    expect(await worker.handle(job(chat, outboundId), attempt())).toBe('reprogramado');
    expect(provider.calls).toHaveLength(0);
    expect(await outbox(outboundId)).toMatchObject({ status: 'queued' });
    const startAfter = sent[0]!.options!.startAfter as Date;
    expect(startAfter.getTime()).toBeGreaterThan(Date.now() + 40_000);
  });

  it('separación en el chat: un saliente hace 5 s sin entrante en el medio → se reprograma 30–60 s', async () => {
    const chat = await freshChat();
    const first = await enqueue(chat);
    const provider = new FakeProvider();
    const { worker, sent } = workerWith(provider);
    expect(await worker.handle(job(chat, first.outboundId), attempt())).toBe('enviado');
    const second = await enqueue(chat);
    expect(await worker.handle(job(chat, second.outboundId), attempt())).toBe('reprogramado');
    expect(sent[0]!.data).toMatchObject({ outboundId: second.outboundId, gapMs: 45_000 });
    expect(provider.sends()).toHaveLength(1);
  });
});

describe('5. errores del proveedor', () => {
  async function failWith(error: string, code: string, attemptInfo = attempt()) {
    const channel = await createChannelTenant(ctx, `err-${uid().slice(0, 6)}`);
    const chat = await createChat(ctx, channel);
    const { outboundId } = await enqueue(chat);
    const provider = new FakeProvider();
    provider.sendResult = () => ({ ok: false, error: error as never, code });
    const { worker } = workerWith(provider);
    const outcome = await worker.handle(job(chat, outboundId), attemptInfo).catch((e: Error) => e);
    return { chat, outboundId, outcome, provider, worker };
  }

  it('transient → vuelve a queued y lanza (pg-boss reintenta); en el último intento queda failed', async () => {
    const { chat, outboundId, outcome, provider, worker } = await failWith('transient', 'ECONNREFUSED');
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).not.toContain(TEXT);
    expect(await outbox(outboundId)).toMatchObject({
      status: 'queued',
      last_error: 'transient',
      attempts: 1,
    });

    // Reintento que sale bien.
    provider.sendResult = null;
    expect(await worker.handle(job(chat, outboundId), attempt(uid(), 1))).toBe('enviado');

    const last = await failWith('rate_limited', 'http_429', attempt(uid(), 5, 5));
    expect(last.outcome).toBe('fallido');
    expect(await outbox(last.outboundId)).toMatchObject({ status: 'failed', last_error: 'rate_limited' });
  });

  it('blocked_risk → canal pausado sin vencimiento, failed, sin reintento ni llamadas de sesión', async () => {
    const { chat, outboundId, outcome, provider } = await failWith('blocked_risk', 'waha_463');
    expect(outcome).toBe('fallido');
    expect(await outbox(outboundId)).toMatchObject({ status: 'failed', last_error: 'blocked_risk' });
    const channel = await channelRow(chat.channelId);
    expect(channel).toMatchObject({ status: 'connected', sending_paused_reason: 'blocked_risk:waha_463' });
    expect(channel.sending_paused_until).toBe(Infinity);
    // La interfaz no tiene cómo reiniciar una sesión: solo visto, escribiendo y enviar.
    expect(new Set(provider.calls.map((call) => call.method))).toEqual(
      new Set(['markSeen', 'startTyping', 'stopTyping', 'sendText']),
    );
    // Lo siguiente del canal se rechaza.
    const next = await createChat(ctx, chat);
    expect(await enqueue(next)).toMatchObject({ status: 'rejected', rejectReason: 'channel_paused' });
  });

  it('session_down → canal disconnected y failed', async () => {
    const { chat, outboundId, outcome } = await failWith('session_down', 'http_422');
    expect(outcome).toBe('fallido');
    expect(await outbox(outboundId)).toMatchObject({ status: 'failed', last_error: 'session_down' });
    expect(await channelRow(chat.channelId)).toMatchObject({ status: 'disconnected' });
  });

  it('blocked_risk en el visto o el escribiendo → no envía y pausa el canal', async () => {
    const chat = await createChat(ctx, await createChannelTenant(ctx, 'seen-risk'));
    const { outboundId } = await enqueue(chat);
    const provider = new FakeProvider();
    provider.presence = { ok: false, error: 'blocked_risk', code: 'waha_475' };
    expect(await workerWith(provider).worker.handle(job(chat, outboundId), attempt())).toBe('fallido');
    expect(provider.sends()).toHaveLength(0);
    expect(await channelRow(chat.channelId)).toMatchObject({
      sending_paused_reason: 'blocked_risk:waha_475',
    });
  });

  it('session_down en el visto → no llega a enviar', async () => {
    const chat = await createChat(ctx, await createChannelTenant(ctx, 'seen-down'));
    const { outboundId } = await enqueue(chat);
    const provider = new FakeProvider();
    provider.presence = { ok: false, error: 'session_down', code: 'http_422' };
    expect(await workerWith(provider).worker.handle(job(chat, outboundId), attempt())).toBe('fallido');
    expect(provider.sends()).toHaveLength(0);
    expect(await channelRow(chat.channelId)).toMatchObject({ status: 'disconnected' });
  });

  it('invalid_recipient y unknown_outcome → failed sin reintento', async () => {
    for (const [error, code] of [
      ['invalid_recipient', 'http_400'],
      ['unknown_outcome', 'http_500'],
    ]) {
      const { outboundId, outcome } = await failWith(error!, code!);
      expect(outcome).toBe('fallido');
      expect(await outbox(outboundId)).toMatchObject({ status: 'failed', last_error: error });
    }
  });
});

describe('4b. respuesta en partes (tarea 010)', () => {
  const partJob = (chat: Chat, outboundId: string, afterOutboundId: string) => ({
    outboundId,
    tenantId: chat.tenantId,
    afterOutboundId,
  });

  it('la parte siguiente se encola con su anterior y arranca un poco después', async () => {
    const chat = await freshChat();
    const first = await enqueue(chat);
    const second = await enqueue(chat, { afterOutboundId: first.outboundId });
    const { rows } = await ctx.ownerPool.query<{ data: OutboundJob; start_after: Date; created_on: Date }>(
      `SELECT data, start_after, created_on FROM pgboss.job WHERE name = $1 AND data->>'outboundId' = $2`,
      [QUEUES.whatsappOutbound, second.outboundId],
    );
    expect(rows[0]!.data.afterOutboundId).toBe(first.outboundId);
    expect(rows[0]!.start_after.getTime()).toBeGreaterThan(rows[0]!.created_on.getTime());
  });

  it('con la anterior enviada sale enseguida, sin la separación de 30–60 s del chat', async () => {
    const chat = await freshChat();
    const first = await enqueue(chat, { body: 'Sí, trabajamos porcelanato símil madera.' });
    const second = await enqueue(chat, { body: '¿Para qué ambiente es?', afterOutboundId: first.outboundId });
    const provider = new FakeProvider();
    const { worker } = workerWith(provider);
    expect(await worker.handle(job(chat, first.outboundId), attempt())).toBe('enviado');
    expect(await worker.handle(partJob(chat, second.outboundId, first.outboundId), attempt())).toBe(
      'enviado',
    );
    expect(provider.sends().map((call) => call.text)).toEqual([
      'Sí, trabajamos porcelanato símil madera.',
      '¿Para qué ambiente es?',
    ]);
    // Cada parte con su visto → "escribiendo…".
    expect(provider.calls.filter((call) => call.method === 'startTyping')).toHaveLength(2);
  });

  it('si la anterior todavía no salió, espera (se reprograma) sin enviar', async () => {
    const chat = await freshChat();
    const first = await enqueue(chat);
    const second = await enqueue(chat, { afterOutboundId: first.outboundId });
    const provider = new FakeProvider();
    const { worker, sent } = workerWith(provider);
    expect(await worker.handle(partJob(chat, second.outboundId, first.outboundId), attempt())).toBe(
      'reprogramado',
    );
    expect(sent[0]!.data).toMatchObject({ outboundId: second.outboundId, afterOutboundId: first.outboundId });
    expect(provider.sends()).toHaveLength(0);
    expect(await outbox(second.outboundId)).toMatchObject({ status: 'queued' });
  });

  it('si la anterior no salió (failed o rejected) → superseded, sin enviar', async () => {
    const chat = await freshChat();
    const first = await enqueue(chat);
    const second = await enqueue(chat, { afterOutboundId: first.outboundId });
    await ctx.ownerPool.query(
      `UPDATE outbound_messages SET status = 'failed', last_error = 'invalid_recipient' WHERE id = $1`,
      [first.outboundId],
    );
    const provider = new FakeProvider();
    const { worker } = workerWith(provider);
    expect(await worker.handle(partJob(chat, second.outboundId, first.outboundId), attempt())).toBe(
      'rechazado',
    );
    expect(await outbox(second.outboundId)).toMatchObject({
      status: 'rejected',
      reject_reason: 'superseded',
    });
    expect(provider.sends()).toHaveLength(0);
  });

  it.each([
    ['escribió el cliente', 'contact'],
    ['respondió una persona', 'user'],
  ] as const)('si entre parte y parte %s → superseded', async (_name, from) => {
    const chat = await freshChat();
    const first = await enqueue(chat);
    const second = await enqueue(chat, { afterOutboundId: first.outboundId });
    const provider = new FakeProvider();
    const { worker } = workerWith(provider);
    expect(await worker.handle(job(chat, first.outboundId), attempt())).toBe('enviado');
    await addMessage(ctx, chat, { from, text: 'otra cosa' });
    expect(await worker.handle(partJob(chat, second.outboundId, first.outboundId), attempt())).toBe(
      'rechazado',
    );
    expect(await outbox(second.outboundId)).toMatchObject({
      status: 'rejected',
      reject_reason: 'superseded',
    });
    expect(provider.sends()).toHaveLength(1);
  });

  it('si la anterior no sale en 10 minutos, la siguiente ya no va (superseded)', async () => {
    const chat = await freshChat();
    const first = await enqueue(chat);
    const second = await enqueue(chat, { afterOutboundId: first.outboundId });
    await ctx.ownerPool.query(
      `UPDATE outbound_messages SET created_at = now() - interval '11 minutes' WHERE id = $1`,
      [second.outboundId],
    );
    const provider = new FakeProvider();
    const { worker } = workerWith(provider);
    expect(await worker.handle(partJob(chat, second.outboundId, first.outboundId), attempt())).toBe(
      'rechazado',
    );
    expect(await outbox(second.outboundId)).toMatchObject({
      status: 'rejected',
      reject_reason: 'superseded',
    });
  });

  it('con la IA pausada (una persona tomó la conversación) → superseded', async () => {
    const chat = await freshChat();
    const first = await enqueue(chat);
    const second = await enqueue(chat, { afterOutboundId: first.outboundId });
    const provider = new FakeProvider();
    const { worker } = workerWith(provider);
    expect(await worker.handle(job(chat, first.outboundId), attempt())).toBe('enviado');
    await ctx.ownerPool.query(
      `UPDATE conversations SET ai_paused_until = now() + interval '12 hours' WHERE id = $1`,
      [chat.conversationId],
    );
    expect(await worker.handle(partJob(chat, second.outboundId, first.outboundId), attempt())).toBe(
      'rechazado',
    );
    expect(provider.sends()).toHaveLength(1);
  });
});

describe('9. aislamiento entre empresas', () => {
  it('A no puede encolar en una conversación de B ni el worker de A toca filas de B', async () => {
    const chatB = await createChat(ctx, b);
    await expect(enqueue(chatB, {}, a.tenantId)).rejects.toBeInstanceOf(ConversationNotFoundError);

    const { outboundId } = await enqueue(chatB);
    const provider = new FakeProvider();
    const outcome = await workerWith(provider).worker.handle({ outboundId, tenantId: a.tenantId }, attempt());
    expect(outcome).toBe('sin_cambios');
    expect(provider.calls).toHaveLength(0);
    expect(await outbox(outboundId)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});

describe('10. permisos de outbound_messages', () => {
  it('RLS forzada, sin DELETE, UPDATE solo de estado y ventas_auth sin acceso', async () => {
    const chat = await freshChat();
    const { outboundId } = await enqueue(chat);
    const { rows } = await ctx.ownerPool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'outbound_messages'",
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    await asApp(ctx, {}, async (c) => {
      expect((await c.query('SELECT id FROM outbound_messages WHERE id = $1', [outboundId])).rowCount).toBe(
        0,
      );
    });
    await asApp(ctx, { tenantId: b.tenantId }, async (c) => {
      expect((await c.query('SELECT id FROM outbound_messages WHERE id = $1', [outboundId])).rowCount).toBe(
        0,
      );
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO outbound_messages (tenant_id, conversation_id, channel_id, idempotency_key, sender_type, body)
           VALUES ($1, $2, $3, 'x', 'app', 'x')`,
          [a.tenantId, chat.conversationId, chat.channelId],
        ),
      ).toBe('42501');
    });
    await asApp(ctx, { tenantId: a.tenantId }, async (c) => {
      expect(await errorCodeIn(c, 'DELETE FROM outbound_messages WHERE id = $1', [outboundId])).toBe('42501');
      expect(
        await errorCodeIn(c, "UPDATE outbound_messages SET body = 'otro' WHERE id = $1", [outboundId]),
      ).toBe('42501');
      expect(
        await errorCodeIn(c, "UPDATE outbound_messages SET status = 'failed' WHERE id = $1", [outboundId]),
      ).toBeUndefined();
      expect(await errorCodeIn(c, 'DROP TABLE outbound_messages')).toBe('42501');
    });
    await expect(ctx.pools.authPool.query('SELECT 1 FROM outbound_messages LIMIT 1')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
