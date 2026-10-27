// Verificación de la tarea 006 contra el Postgres local con un LlmClient falso: debounce (1), filtros (2),
// puntaje guardado (3), disparadores (5, 6), calificación y combinación (7), derivación (8, 9), salida
// inválida y controles, entrantes sin texto, re-verificación en T2, idempotencia, aislamiento, permisos y
// logs. Números ficticios; textos inventados.
import { Logger } from '@nestjs/common';
import type { MessageReceivedEvent } from '@ventas/shared';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantConfigService } from '../src/ai/config/tenant-config.service.js';
import { NoopBudgetGuard } from '../src/ai/llm/budget-guard.js';
import { LlmError } from '../src/ai/llm/llm-client.js';
import { AiReplyService } from '../src/ai/reply/ai-reply.service.js';
import { CatalogRefreshWorker } from '../src/catalog/catalog-refresh.worker.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import type { Env } from '../src/config/env.js';
import { APP_DB, type AppDatabase } from '../src/db/database.module.js';
import { withTenantTransaction } from '../src/db/tenant-context.js';
import { BOSS, QUEUES } from '../src/jobs/jobs.module.js';
import { OutboundService } from '../src/messaging/outbound/outbound.service.js';
import type { PresenceService } from '../src/messaging/outbound/presence.service.js';
import { InboundService } from '../src/whatsapp/inbound/inbound.service.js';
import {
  addMessage,
  agentOutput,
  AVAILABILITY_INTRO,
  charged,
  CLOSED_WEEK,
  FakeLlm,
  FakeLlmFactory,
  FakePresence,
  MEDIA_ASK,
  MSG_AFTER_HOURS,
  MSG_IN_HOURS,
  signals,
  testConfig,
  testConfigInput,
  withAvailabilityAfterFields,
} from './ai-helpers.js';
import { asApp, errorCodeIn, startTestContext, type TestContext } from './helpers.js';
import { createChannelTenant, createChat, uid, type Chat } from './outbound-helpers.js';
import type { TenantConfigInput } from '@ventas/shared';

let ctx: TestContext;
let db: AppDatabase;
let outbound: OutboundService;
const configs = new TenantConfigService();
const fake = new FakeLlm();
const presence = new FakePresence();
let service: AiReplyService;

// Todo lo que se loguea durante los tests, para buscar datos personales al final.
const logged: string[] = [];
const SECRET = 'TEXTO-PRIVADO-DEL-CLIENTE';

function makeService(env: Partial<Env> = {}) {
  return new AiReplyService(
    { ...ctx.env, AI_ENABLED: true, ...env },
    db,
    new FakeLlmFactory(fake),
    new NoopBudgetGuard(),
    configs,
    outbound,
    presence as unknown as PresenceService,
    ctx.app.get(CatalogService),
    ctx.app.get(CatalogRefreshWorker),
  );
}

beforeAll(async () => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  }
  ctx = await startTestContext();
  // Los workers reales no toman estos trabajos: el servicio se llama a mano y los envíos quedan en cola.
  const boss = ctx.app.get<PgBoss>(BOSS);
  await boss.offWork(QUEUES.aiReply);
  await boss.offWork(QUEUES.whatsappOutbound);
  db = ctx.app.get<AppDatabase>(APP_DB);
  outbound = ctx.app.get(OutboundService);
  service = makeService();
});

afterAll(async () => {
  await ctx?.close();
  vi.restoreAllMocks();
});

async function setup(
  configOverride: (input: TenantConfigInput) => TenantConfigInput = (input) => input,
  chatOptions: { blocked?: boolean } = {},
): Promise<Chat> {
  const channel = await createChannelTenant(ctx, uid().slice(0, 8));
  const chat = await createChat(ctx, channel, chatOptions);
  await withTenantTransaction(db.db, { tenantId: chat.tenantId }, (tx) =>
    configs.insertVersion(tx, configOverride(testConfigInput([chat.channelId]))),
  );
  return chat;
}

const run = (chat: Chat, messageId: string, svc = service) =>
  svc.process({ tenantId: chat.tenantId, conversationId: chat.conversationId, messageId });

async function conversation(chat: Chat) {
  const { rows } = await ctx.ownerPool.query('SELECT * FROM conversations WHERE id = $1', [
    chat.conversationId,
  ]);
  return rows[0];
}

async function runs(chat: Chat) {
  const { rows } = await ctx.ownerPool.query(
    'SELECT * FROM ai_runs WHERE conversation_id = $1 ORDER BY created_at',
    [chat.conversationId],
  );
  return rows;
}

async function outbox(chat: Chat) {
  const { rows } = await ctx.ownerPool.query(
    'SELECT sender_type, body, idempotency_key, status FROM outbound_messages WHERE conversation_id = $1 ORDER BY created_at',
    [chat.conversationId],
  );
  return rows as { sender_type: string; body: string; idempotency_key: string; status: string }[];
}

/** Simula que el worker de envío mandó lo encolado (fila sent + mensaje saliente). */
async function deliver(chat: Chat) {
  for (const row of await outbox(chat)) {
    if (row.status !== 'queued') continue;
    await ctx.ownerPool.query(
      `UPDATE outbound_messages SET status = 'sent', external_id = 'true_' || id WHERE idempotency_key = $1 AND conversation_id = $2`,
      [row.idempotency_key, chat.conversationId],
    );
    await addMessage(ctx, chat, { from: row.sender_type as 'ai' | 'app', text: row.body });
  }
}

const config = testConfig();
const reply = (text: string, extra: Parameters<typeof agentOutput>[1] = {}) =>
  agentOutput(config, { action: 'reply', reply: text, ...extra });

describe('1. debounce', () => {
  it('tres entrantes seguidos → tres trabajos singleton con espera; una sola corrida con los tres', async () => {
    const chat = await setup();
    const inbound = ctx.app.get(InboundService);
    const texts = ['Hola', 'quiero hacer el piso del living', `son unos 30 m2 ${SECRET}`];
    for (const text of texts) {
      const event: MessageReceivedEvent = {
        type: 'message.received',
        provider: 'waha',
        channelExternalId: chat.session,
        eventId: uid(),
        externalMessageId: `false_${uid().toUpperCase()}`,
        contact: { waId: chat.waId, profileName: null },
        messageType: 'text',
        body: text,
        sentAt: new Date().toISOString(),
        raw: {},
      };
      expect(await inbound.process(event, { channelId: chat.channelId, tenantId: chat.tenantId })).toBe(
        'guardado',
      );
    }
    const { rows: jobs } = await ctx.ownerPool.query<{
      data: { messageId: string };
      singleton_key: string;
      delay: number;
    }>(
      `SELECT data, singleton_key, EXTRACT(EPOCH FROM (start_after - created_on)) AS delay
       FROM pgboss.job WHERE name = $1 AND data->>'conversationId' = $2 ORDER BY created_on`,
      [QUEUES.aiReply, chat.conversationId],
    );
    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect(job.singleton_key).toBe(chat.conversationId);
      expect(Number(job.delay)).toBeGreaterThanOrEqual(9);
    }

    fake.requests = [];
    fake.respond = () => reply('¿Para cuándo lo necesitás?');
    const outcomes = [];
    for (const job of jobs) outcomes.push(await run(chat, job.data.messageId));
    expect(outcomes.map((outcome) => outcome.decision)).toEqual([
      'skipped:superseded',
      'skipped:superseded',
      'replied',
    ]);
    expect(fake.requests).toHaveLength(1);
    for (const text of texts)
      expect(fake.requests[0]!.messages[0]!.content).toContain(text.replace(SECRET, ''));
    expect(await runs(chat)).toHaveLength(1);
  });
});

describe('2. filtros: no se llama al modelo y queda el motivo', () => {
  const cases: [string, () => Promise<{ chat: Chat; messageId: string; svc?: AiReplyService }>][] = [
    [
      'ai_disabled',
      async () => {
        const chat = await setup();
        return { chat, messageId: await addMessage(ctx, chat), svc: makeService({ AI_ENABLED: false }) };
      },
    ],
    [
      'tenant_disabled',
      async () => {
        const chat = await setup((input) => ({ ...input, ai: { ...input.ai, enabled: false } }));
        return { chat, messageId: await addMessage(ctx, chat) };
      },
    ],
    [
      'channel_disabled',
      async () => {
        const chat = await setup((input) => ({ ...input, ai: { ...input.ai, channel_ids: [] } }));
        return { chat, messageId: await addMessage(ctx, chat) };
      },
    ],
    [
      'ai_paused',
      async () => {
        const chat = await setup();
        await ctx.ownerPool.query(
          `UPDATE conversations SET ai_paused_until = now() + interval '1 hour' WHERE id = $1`,
          [chat.conversationId],
        );
        return { chat, messageId: await addMessage(ctx, chat) };
      },
    ],
    [
      'handed_off',
      async () => {
        const chat = await setup();
        await ctx.ownerPool.query(
          `UPDATE conversations SET handed_off_at = now(), handoff_reason = 'qualified' WHERE id = $1`,
          [chat.conversationId],
        );
        return { chat, messageId: await addMessage(ctx, chat) };
      },
    ],
    [
      'inbox_other',
      async () => {
        const chat = await setup();
        await ctx.ownerPool.query(`UPDATE conversations SET inbox = 'other' WHERE id = $1`, [
          chat.conversationId,
        ]);
        return { chat, messageId: await addMessage(ctx, chat) };
      },
    ],
    [
      'contact_blocked',
      async () => {
        const chat = await setup(undefined, { blocked: true });
        return { chat, messageId: await addMessage(ctx, chat) };
      },
    ],
    [
      'last_not_client',
      async () => {
        const chat = await setup();
        const messageId = await addMessage(ctx, chat);
        await addMessage(ctx, chat, { from: 'user', text: 'Hola, te atiendo yo' });
        return { chat, messageId };
      },
    ],
    [
      'pending_outbound',
      async () => {
        const chat = await setup();
        const messageId = await addMessage(ctx, chat);
        await withTenantTransaction(db.db, { tenantId: chat.tenantId }, (tx) =>
          outbound.enqueueText(
            {
              conversationId: chat.conversationId,
              body: 'Ya te escribo',
              senderType: 'app',
              idempotencyKey: uid(),
            },
            tx,
          ),
        );
        return { chat, messageId };
      },
    ],
  ];

  it.each(cases)('%s', async (reason, prepare) => {
    const { chat, messageId, svc } = await prepare();
    fake.requests = [];
    fake.respond = () => reply('No debería salir');
    expect((await run(chat, messageId, svc)).decision).toBe(`skipped:${reason}`);
    expect(fake.requests).toHaveLength(0);
    expect((await runs(chat)).map((row) => row.decision)).toEqual([`skipped:${reason}`]);
    expect((await outbox(chat)).filter((row) => row.sender_type === 'ai')).toEqual([]);
  });

  it('sin config → skipped:no_config', async () => {
    const chat = await createChat(ctx, await createChannelTenant(ctx, uid().slice(0, 8)));
    fake.requests = [];
    expect((await run(chat, await addMessage(ctx, chat))).decision).toBe('skipped:no_config');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('3 y 7. puntaje y calificación', () => {
  it('reply de calificación: se envía como ai con ai:<id>, el puntaje y el desglose quedan guardados y los datos se combinan', async () => {
    const chat = await setup();
    await ctx.ownerPool.query(`UPDATE conversations SET extracted_data = '{"m2": 40}' WHERE id = $1`, [
      chat.conversationId,
    ]);
    const messageId = await addMessage(ctx, chat, { text: 'Es para el living' });
    fake.respond = () =>
      reply('¿Para cuándo lo necesitás?', {
        signals: signals(config, 3),
        extracted: { ...agentOutput(config).extracted, producto_ambiente: 'living' },
      });
    expect((await run(chat, messageId)).decision).toBe('replied');

    expect(await outbox(chat)).toMatchObject([
      { sender_type: 'ai', body: '¿Para cuándo lo necesitás?', idempotency_key: `ai:${messageId}` },
    ]);
    const row = await conversation(chat);
    // señales 3/5 en todo (0,6 × 8) + completitud 2/3 × 2 → round(100 × (4,8 + 1,333) / 10) = 61
    expect(row.lead_score).toBe(61);
    expect(row.lead_tier).toBe('warm');
    expect(row.score_breakdown).toMatchObject({
      score: 61,
      tier: 'warm',
      completeness: { obtained: ['producto_ambiente', 'm2'] },
    });
    expect(row.extracted_data).toEqual({ m2: 40, producto_ambiente: 'living' });
    expect(row.qualification_turns).toBe(1);
    expect(row.handed_off_at).toBeNull();
    const [aiRun] = await runs(chat);
    expect(aiRun).toMatchObject({
      decision: 'replied',
      score: 61,
      prompt_version: 'v2',
      config_version: 1,
      provider: 'openrouter',
      billing_mode: 'platform',
      cost_usd: '0.00020000',
      cost_source: 'provider',
    });
  });

  it('5. el mismo trabajo dos veces → un solo envío y una sola llamada', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat);
    fake.requests = [];
    fake.respond = () => reply('Abrimos todos los días.');
    await run(chat, messageId);
    expect((await run(chat, messageId)).decision).toBe('skipped:duplicate');
    expect(fake.requests).toHaveLength(1);
    expect((await outbox(chat)).filter((row) => row.sender_type === 'ai')).toHaveLength(1);
  });
});

describe('5 y 6. disparadores', () => {
  it('availability immediate → deriva con el texto fijo, aunque el modelo quiera responder', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat, { text: '¿tienen el 60x60 gris?' });
    fake.respond = () => reply('Sí, lo tenemos', { triggers: ['availability'] });
    expect((await run(chat, messageId)).decision).toBe('handed_off');
    expect(await outbox(chat)).toMatchObject([
      { sender_type: 'app', body: MSG_IN_HOURS, idempotency_key: `handoff:${chat.conversationId}` },
    ]);
    expect(await conversation(chat)).toMatchObject({ handoff_reason: 'availability' });
  });

  it('6. respaldo en código: "¿lo tienen para retirar hoy?" deriva aunque el modelo no lo marque', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat, { text: '¿lo tienen para retirar hoy?' });
    fake.respond = () => reply('¡Sí! Pasá cuando quieras.');
    expect((await run(chat, messageId)).decision).toBe('handed_off');
    const [aiRun] = await runs(chat);
    expect(aiRun.triggers_code).toContain('availability');
    expect(aiRun.triggers_model).toEqual([]);
    expect((await outbox(chat)).map((row) => row.sender_type)).toEqual(['app']);
  });

  it('availability after_fields → primero pregunta lo que falta (texto del código) y después deriva', async () => {
    const chat = await setup(withAvailabilityAfterFields);
    const first = await addMessage(ctx, chat, { text: '¿Hay stock del porcelanato gris?' });
    fake.respond = () => reply('Sí, hay stock', { triggers: ['availability'] });
    expect((await run(chat, first)).decision).toBe('asked_fields');
    expect(await outbox(chat)).toMatchObject([
      {
        sender_type: 'ai',
        body: `${AVAILABILITY_INTRO} ¿Cuántos m² necesitás, más o menos? ¿Cómo es tu nombre?`,
      },
    ]);

    await deliver(chat);
    const second = await addMessage(ctx, chat, { text: 'Unos 40 m2, soy Ana' });
    fake.respond = () =>
      agentOutput(config, {
        action: 'reply',
        reply: 'Gracias Ana',
        triggers: ['availability'],
        extracted: { ...agentOutput(config).extracted, m2: 40, nombre: 'Ana' },
      });
    expect((await run(chat, second)).decision).toBe('handed_off');
    const row = await conversation(chat);
    expect(row.handoff_reason).toBe('availability');
    expect(row.handoff_summary).toContain('40');
    expect(row.handoff_summary).toContain('Ana');
  });
});

describe('8 y 9. derivación', () => {
  it('puntaje alto con todo completo → deriva con el resumen, el puntaje y lo descubierto', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat, { text: 'Living, 40 m2, lo compro el lunes' });
    fake.respond = () =>
      reply('¡Genial!', {
        signals: signals(config, 5),
        extracted: { producto_ambiente: 'living', m2: 40, fecha_compra: '2026-11-02', nombre: null },
        discovered: [{ topic: 'obra', value: 'compra desde cero', evidence: 'lo compro el lunes' }],
        handoff_summary: 'Quiere porcelanato para el living.',
      });
    expect((await run(chat, messageId)).decision).toBe('handed_off');
    const row = await conversation(chat);
    expect(row).toMatchObject({
      handoff_reason: 'qualified',
      lead_score: 100,
      lead_tier: 'hot',
      lead_score_peak: 100,
    });
    for (const value of ['living', '40', '2026-11-02', 'compra desde cero'])
      expect(row.handoff_summary).toContain(value);
    expect(row.discovered_notes).toEqual([
      { topic: 'obra', value: 'compra desde cero', evidence: 'lo compro el lunes' },
    ]);
    expect((await outbox(chat)).map((r) => [r.sender_type, r.body])).toEqual([['app', MSG_IN_HOURS]]);
  });

  it('puntaje alto con los turnos calientes agotados → deriva aunque falten datos', async () => {
    const chat = await setup();
    await ctx.ownerPool.query(
      'UPDATE conversations SET hot_turns = 2, qualification_turns = 2 WHERE id = $1',
      [chat.conversationId],
    );
    const messageId = await addMessage(ctx, chat, { text: 'lo necesito ya' });
    fake.respond = () => reply('¿Cuántos m²?', { signals: signals(config, 5) });
    expect((await run(chat, messageId)).decision).toBe('handed_off');
    expect((await conversation(chat)).handoff_reason).toBe('hot_turns');
  });

  it('puntaje alto con los turnos de calificación agotados → deriva igual', async () => {
    const chat = await setup((input) => ({
      ...input,
      qualification: { ...input.qualification, max_turns_when_hot: 10 },
    }));
    await ctx.ownerPool.query('UPDATE conversations SET qualification_turns = 6 WHERE id = $1', [
      chat.conversationId,
    ]);
    const messageId = await addMessage(ctx, chat);
    fake.respond = () => reply('¿Cuántos m²?', { signals: signals(config, 5) });
    expect((await run(chat, messageId)).decision).toBe('handed_off');
    expect((await conversation(chat)).handoff_reason).toBe('max_turns');
  });

  it('9. después de derivar, los entrantes nuevos no disparan nada y el texto fijo sale una vez (fuera de horario)', async () => {
    const chat = await setup((input) => ({
      ...input,
      business: { ...input.business, service_hours: CLOSED_WEEK },
    }));
    const first = await addMessage(ctx, chat, { text: 'quiero hablar con una persona' });
    fake.respond = () => reply('Claro');
    expect((await run(chat, first)).decision).toBe('handed_off');
    await deliver(chat);
    fake.requests = [];
    for (const text of ['hola?', '¿siguen ahí?']) {
      const id = await addMessage(ctx, chat, { text });
      expect((await run(chat, id)).decision).toBe('skipped:handed_off');
    }
    expect(fake.requests).toHaveLength(0);
    const sent = await outbox(chat);
    expect(sent.map((row) => [row.sender_type, row.body])).toEqual([['app', MSG_AFTER_HOURS]]);
  });
});

describe('6 y 11. salida inválida, controles y errores', () => {
  it('salida inválida → no se envía nada, queda derivada y el costo registrado', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat);
    fake.respond = () => new LlmError('invalid_output', false, charged('0.0003'));
    expect((await run(chat, messageId)).decision).toBe('error:invalid_output');
    const row = await conversation(chat);
    expect(row.handoff_reason).toBe('invalid_output');
    expect(row.handoff_summary).toContain('invalid_output');
    expect((await runs(chat))[0]).toMatchObject({ cost_usd: '0.00030000', output: null });
    expect((await outbox(chat)).map((r) => r.sender_type)).toEqual(['app']);
  });

  it('respuesta con un monto que no está en la config → bloqueada y derivada', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat);
    fake.respond = () => reply('El m² sale $ 9.999');
    expect((await run(chat, messageId)).decision).toBe('blocked:money');
    expect((await conversation(chat)).handoff_reason).toBe('blocked:money');
    expect((await outbox(chat)).map((r) => r.sender_type)).toEqual(['app']);
  });

  it('error de transporte → error:<tipo>, sin derivar y sin envío', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat);
    fake.respond = () => new LlmError('timeout', true);
    expect((await run(chat, messageId)).decision).toBe('error:timeout');
    expect((await conversation(chat)).handed_off_at).toBeNull();
    expect(await outbox(chat)).toEqual([]);
  });
});

describe('entrantes sin texto', () => {
  it('ask_text: pide texto una vez; el siguiente audio deriva, sin llamar al modelo', async () => {
    const chat = await setup();
    fake.requests = [];
    const first = await addMessage(ctx, chat, { text: null, type: 'audio' });
    expect((await run(chat, first)).decision).toBe('asked_text');
    expect(await outbox(chat)).toMatchObject([{ sender_type: 'app', body: MEDIA_ASK }]);
    await deliver(chat);
    const second = await addMessage(ctx, chat, { text: null, type: 'image' });
    expect((await run(chat, second)).decision).toBe('handed_off');
    expect((await conversation(chat)).handoff_reason).toBe('unsupported_media');
    expect(fake.requests).toHaveLength(0);
  });

  it('handoff: deriva directo', async () => {
    const chat = await setup((input) => ({
      ...input,
      handoff: { ...input.handoff, unsupported_media: { mode: 'handoff' } },
    }));
    const messageId = await addMessage(ctx, chat, { text: null, type: 'audio' });
    expect((await run(chat, messageId)).decision).toBe('handed_off');
    expect((await outbox(chat)).map((r) => r.body)).toEqual([MSG_IN_HOURS]);
  });
});

describe('T2: re-verificación con la conversación bloqueada', () => {
  it('una persona pausa la IA durante la llamada → no se envía y el costo queda registrado', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat);
    fake.respond = async () => {
      await ctx.ownerPool.query(
        `UPDATE conversations SET ai_paused_until = now() + interval '12 hours' WHERE id = $1`,
        [chat.conversationId],
      );
      return reply('Hola');
    };
    expect((await run(chat, messageId)).decision).toBe('skipped:ai_paused');
    expect(await outbox(chat)).toEqual([]);
    expect((await runs(chat))[0]).toMatchObject({ decision: 'skipped:ai_paused', cost_usd: '0.00020000' });
  });

  it('llega otro entrante durante la llamada → superseded (lo procesa el trabajo del nuevo)', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat);
    fake.respond = async () => {
      await addMessage(ctx, chat, { text: 'y otra cosa' });
      return reply('Hola');
    };
    expect((await run(chat, messageId)).decision).toBe('skipped:superseded');
    expect(await outbox(chat)).toEqual([]);
  });
});

describe('9. aislamiento y permisos', () => {
  it('la config y las corridas de A no se ven desde B, y el prompt de A no tiene datos de B', async () => {
    const a = await setup((input) => ({ ...input, business: { ...input.business, name: 'Empresa Alfa' } }));
    const b = await setup((input) => ({ ...input, business: { ...input.business, name: 'Empresa Beta' } }));
    fake.requests = [];
    fake.respond = () => reply('Hola');
    await run(a, await addMessage(ctx, a));
    const system = fake.requests[0]!.system;
    expect(system).toContain('Empresa Alfa');
    expect(system).not.toContain('Empresa Beta');

    await asApp(ctx, { tenantId: b.tenantId }, async (client) => {
      const configsOfA = await client.query(
        'SELECT count(*)::int AS n FROM tenant_configs WHERE tenant_id = $1',
        [a.tenantId],
      );
      const runsOfA = await client.query('SELECT count(*)::int AS n FROM ai_runs WHERE tenant_id = $1', [
        a.tenantId,
      ]);
      expect(configsOfA.rows[0].n).toBe(0);
      expect(runsOfA.rows[0].n).toBe(0);
      expect(
        await errorCodeIn(
          client,
          `INSERT INTO tenant_configs (tenant_id, version, config) VALUES ($1, 99, '{}')`,
          [a.tenantId],
        ),
      ).toBe('42501');
    });
    await asApp(ctx, {}, async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM ai_runs')).rows[0].n).toBe(0);
    });
  });

  it('ventas_app no puede editar ni borrar configs ni corridas, ni tocar otras columnas de la conversación', async () => {
    const chat = await setup();
    await asApp(ctx, { tenantId: chat.tenantId }, async (client) => {
      expect(await errorCodeIn(client, `UPDATE tenant_configs SET version = 5`)).toBe('42501');
      expect(await errorCodeIn(client, `DELETE FROM tenant_configs`)).toBe('42501');
      expect(await errorCodeIn(client, `UPDATE ai_runs SET decision = 'none'`)).toBe('42501');
      expect(await errorCodeIn(client, `DELETE FROM ai_runs`)).toBe('42501');
      expect(
        await errorCodeIn(client, `UPDATE conversations SET lead_score = 50 WHERE id = $1`, [
          chat.conversationId,
        ]),
      ).toBeUndefined();
      expect(
        await errorCodeIn(client, `UPDATE conversations SET tenant_id = tenant_id WHERE id = $1`, [
          chat.conversationId,
        ]),
      ).toBe('42501');
    });
  });
});

describe('correcciones de la revisión (e2e)', () => {
  it('empresa suspendida con un trabajo encolado → skipped:tenant_suspended, sin modelo', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat);
    await ctx.ownerPool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [chat.tenantId]);
    fake.requests = [];
    expect((await run(chat, messageId)).decision).toBe('skipped:tenant_suspended');
    expect(fake.requests).toHaveLength(0);
  });

  it('0010: sin usuario, con app.tenant_id = B se ve solo la empresa B; sin contexto, ninguna', async () => {
    const a = await setup();
    const b = await setup();
    await asApp(ctx, { tenantId: b.tenantId }, async (client) => {
      const { rows } = await client.query<{ id: string }>('SELECT id FROM tenants');
      expect(rows.map((row) => row.id)).toEqual([b.tenantId]);
      expect(rows.map((row) => row.id)).not.toContain(a.tenantId);
    });
    await asApp(ctx, {}, async (client) => {
      expect((await client.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n).toBe(0);
    });
  });

  it('after_fields en otro idioma sin intro → deriva directo (:idioma), sin preguntar', async () => {
    const chat = await setup(withAvailabilityAfterFields);
    const messageId = await addMessage(ctx, chat, { text: 'Is it still available?' });
    fake.respond = () => reply('Yes', { triggers: ['availability'], language: 'en' });
    expect((await run(chat, messageId)).decision).toBe('handed_off');
    expect((await conversation(chat)).handoff_reason).toBe('availability:idioma');
    expect((await outbox(chat)).map((r) => r.sender_type)).toEqual(['app']);
  });

  it('sugerencia con el tope alcanzado → blocked:suggestion_limit y derivada', async () => {
    const chat = await setup();
    await ctx.ownerPool.query('UPDATE conversations SET suggestions_count = 2 WHERE id = $1', [
      chat.conversationId,
    ]);
    const messageId = await addMessage(ctx, chat);
    fake.respond = () => reply('¿Le sumamos pegamento?', { suggestion: 'pegamento' });
    expect((await run(chat, messageId)).decision).toBe('blocked:suggestion_limit');
    expect((await outbox(chat)).map((r) => r.sender_type)).toEqual(['app']);
  });
});

describe('"escribiendo…" mientras la IA piensa', () => {
  it('se pone antes de llamar al modelo y el envío lleva desde cuándo, para descontarlo de la demora', async () => {
    const chat = await setup();
    const messageId = await addMessage(ctx, chat);
    const since = new Date(Date.now() - 4_000);
    presence.typingSince = since;
    fake.respond = () => {
      // Cuando el modelo piensa, el chat ya muestra "escribiendo…".
      expect(presence.of(chat.conversationId)).toEqual(['start']);
      return reply('Abrimos de 9 a 17:30.');
    };
    expect((await run(chat, messageId)).decision).toBe('replied');
    presence.typingSince = null;
    expect(presence.of(chat.conversationId)).toEqual(['start']);
    const { rows } = await ctx.ownerPool.query<{ data: { typingSince?: string } }>(
      `SELECT j.data FROM pgboss.job j JOIN outbound_messages o ON o.id::text = j.data->>'outboundId'
       WHERE j.name = $1 AND o.conversation_id = $2`,
      [QUEUES.whatsappOutbound, chat.conversationId],
    );
    expect(rows.map((row) => row.data.typingSince)).toEqual([since.toISOString()]);
  });

  it('si al final no manda nada (none, pausada durante la llamada), saca el "escribiendo…"', async () => {
    const quiet = await setup();
    fake.respond = () => agentOutput(config, { action: 'none' });
    expect((await run(quiet, await addMessage(ctx, quiet))).decision).toBe('none');
    expect(presence.of(quiet.conversationId)).toEqual(['start', 'stop']);

    const paused = await setup();
    const messageId = await addMessage(ctx, paused);
    fake.respond = async () => {
      await ctx.ownerPool.query(
        `UPDATE conversations SET ai_paused_until = now() + interval '1 hour' WHERE id = $1`,
        [paused.conversationId],
      );
      return reply('Hola');
    };
    expect((await run(paused, messageId)).decision).toBe('skipped:ai_paused');
    expect(presence.of(paused.conversationId)).toEqual(['start', 'stop']);
  });

  it('con un filtro que corta antes del modelo no se muestra nada', async () => {
    const chat = await setup((input) => ({ ...input, ai: { ...input.ai, enabled: false } }));
    expect((await run(chat, await addMessage(ctx, chat))).decision).toBe('skipped:tenant_disabled');
    expect(presence.of(chat.conversationId)).toEqual([]);
  });
});

describe('logs', () => {
  it('sin texto del cliente, respuestas ni teléfonos', () => {
    const all = logged.join('\n');
    expect(all).toContain('ai-reply');
    for (const forbidden of [
      SECRET,
      'living',
      '¿Para cuándo lo necesitás?',
      'Abrimos',
      'Empresa Alfa',
      '+549',
    ]) {
      expect(all).not.toContain(forbidden);
    }
  });
});
