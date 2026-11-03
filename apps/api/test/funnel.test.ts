// Verificación de la tarea 028 (embudo de ventas) contra el Postgres local. Números ficticios; textos
// inventados. Empresa en America/Argentina/Buenos_Aires (UTC-3), atención de lunes a viernes de 9 a 18.
//
// Cohorte del 5 al 18/10/2026 (semanas W1 = lunes 5/10 y W2 = lunes 12/10) en la empresa A. Cada letra es una
// conversación que recorre un camino; las cuentas esperadas están hechas a mano en cada `it`.
import { Logger } from '@nestjs/common';
import type { TenantConfigInput } from '@ventas/shared';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantConfigService } from '../src/ai/config/tenant-config.service.js';
import { NoopBudgetGuard } from '../src/ai/llm/budget-guard.js';
import { AiReplyService } from '../src/ai/reply/ai-reply.service.js';
import { businessSecondsBetween } from '../src/ai/reply/business-hours.js';
import { CatalogRefreshWorker } from '../src/catalog/catalog-refresh.worker.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import { APP_DB, type AppDatabase } from '../src/db/database.module.js';
import { withTenantTransaction } from '../src/db/tenant-context.js';
import { backfillFunnelConversation, highestTier } from '../src/funnel/funnel-backfill.js';
import { FunnelService, weeksOf } from '../src/funnel/funnel.service.js';
import { BOSS, QUEUES } from '../src/jobs/jobs.module.js';
import { OutboundService } from '../src/messaging/outbound/outbound.service.js';
import type { PresenceService } from '../src/messaging/outbound/presence.service.js';
import { refreshConversationMetrics } from '../src/performance/conversation-metrics.js';
import {
  agentOutput,
  FakeLlm,
  FakeLlmFactory,
  FakePresence,
  signals,
  testConfig,
  testConfigInput,
} from './ai-helpers.js';
import {
  addMember,
  createTenant,
  createUser,
  HttpClient,
  startTestContext,
  withTenant,
  type TestContext,
} from './helpers.js';
import { fakePhone, uid } from './outbound-helpers.js';

let ctx: TestContext;
let db: AppDatabase;
const configs = new TenantConfigService();
const logged: string[] = [];
const SECRET = 'TEXTO-PRIVADO-DEL-EMBUDO';

type UserKey = 'owner' | 'admin' | 'seller' | 'seller2' | 'viewer' | 'ownerB';
const users = {} as Record<UserKey, { id: string; email: string }>;
const clients = {} as Record<UserKey, HttpClient>;
let tenantA: string;
let tenantB: string;
let tenantC: string;
// A1: un vendedor (seller). A2: dos vendedores. A3: estancados y montos (fuera de la cohorte). B1: otra empresa.
const channels = {} as Record<'A1' | 'A2' | 'A3' | 'B1' | 'C1', { id: string; session: string }>;

const WEEKDAYS = (() => {
  const day = [{ open: '09:00', close: '18:00' }];
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: [], sun: [] };
})();
const TZ = 'America/Argentina/Buenos_Aires';

function configFor(channelIds: string[], extra: Partial<TenantConfigInput> = {}): TenantConfigInput {
  const input = testConfigInput(channelIds);
  return { ...input, business: { ...input.business!, service_hours: WEEKDAYS }, ...extra };
}

async function setConfig(tenantId: string, input: TenantConfigInput) {
  await withTenantTransaction(db.db, { tenantId }, (tx) => configs.insertVersion(tx, input));
}

async function createChannel(tenantId: string, ownerId: string, name: string) {
  const session = `${ctx.prefix}_funnel_${uid()}`;
  const id = await withTenant(ctx, tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type, external_id,
         status, risk_accepted_at, risk_accepted_by)
       VALUES ($1, $2, $3, 'waha', 'unofficial', $4, 'connected', now(), $5) RETURNING id`,
      [tenantId, name, `+${fakePhone()}`, session, ownerId],
    );
    return rows[0]!.id;
  });
  return { id, session };
}

interface Conv {
  tenantId: string;
  channelId: string;
  conversationId: string;
}

async function insertMessage(
  conv: Conv,
  from: 'contact' | 'user' | 'ai',
  at: Date,
  text: string,
  sentByUserId: string | null = null,
): Promise<string> {
  return withTenant(ctx, conv.tenantId, async (c) => {
    const inbound = from === 'contact';
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
         sent_by_user_id, type, body, status, raw, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'text', $8, $9, '{}'::jsonb, $10) RETURNING id`,
      [
        conv.tenantId,
        conv.conversationId,
        conv.channelId,
        `${inbound ? 'false' : 'true'}_${uid().toUpperCase()}`,
        inbound ? 'inbound' : 'outbound',
        from,
        sentByUserId,
        text,
        inbound ? 'received' : 'sent',
        at,
      ],
    );
    await c.query('UPDATE conversations SET last_message_at = GREATEST(last_message_at, $2) WHERE id = $1', [
      conv.conversationId,
      at,
    ]);
    return rows[0]!.id;
  });
}

async function createConversation(tenantId: string, channelId: string, at: Date): Promise<Conv> {
  const conv = await withTenant(ctx, tenantId, async (c) => {
    const contact = await c.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, wa_id, profile_name, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'Cliente', $3, $3) RETURNING id`,
      [tenantId, `+${fakePhone()}`, at],
    );
    const conversation = await c.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, channel_id, contact_id, last_message_at, last_inbound_at, created_at)
       VALUES ($1, $2, $3, $4, $4, $4) RETURNING id`,
      [tenantId, channelId, contact.rows[0]!.id, at],
    );
    return { tenantId, channelId, conversationId: conversation.rows[0]!.id };
  });
  await insertMessage(conv, 'contact', at, `Hola ${SECRET}`);
  return conv;
}

const refresh = (conv: Conv) =>
  withTenantTransaction(db.db, { tenantId: conv.tenantId }, (tx) =>
    refreshConversationMetrics(tx, conv.conversationId),
  );

/** Hora local de Buenos Aires. */
const ar = (local: string) => new Date(`${local}:00-03:00`);

interface Path {
  at: string;
  channel?: 'A1' | 'A2';
  tier?: 'cold' | 'warm' | 'hot';
  score?: number;
  handoff?: string;
  /** Respuesta humana: hora y quién (null = desde el teléfono). */
  human?: { at: string; by: UserKey | null };
  close?: { at: string; outcome: string; amount?: string };
}

/** Arma una conversación con su camino (como owner, sin pasar por la API) y recalcula sus métricas. */
async function path(spec: Path): Promise<Conv> {
  const conv = await createConversation(tenantA, channels[spec.channel ?? 'A1'].id, ar(spec.at));
  if (spec.tier || spec.score !== undefined) {
    await ctx.ownerPool.query(
      'UPDATE conversations SET lead_tier_peak = $2, lead_tier = $2, lead_score = $3 WHERE id = $1',
      [conv.conversationId, spec.tier ?? null, spec.score ?? null],
    );
  }
  if (spec.handoff) {
    await ctx.ownerPool.query(
      `UPDATE conversations SET handed_off_at = $2, handoff_reason = 'asks_human' WHERE id = $1`,
      [conv.conversationId, ar(spec.handoff)],
    );
    await refresh(conv);
  }
  if (spec.human) {
    const by = spec.human.by ? users[spec.human.by].id : null;
    await insertMessage(conv, 'user', ar(spec.human.at), `Te ayudo ${SECRET}`, by);
  }
  if (spec.close) {
    await ctx.ownerPool.query(
      `UPDATE conversations SET status = 'closed', closed_at = $2, close_outcome = $3, close_amount = $4
       WHERE id = $1`,
      [conv.conversationId, ar(spec.close.at), spec.close.outcome, spec.close.amount ?? null],
    );
  }
  await refresh(conv);
  return conv;
}

async function login(key: UserKey, tenantId: string) {
  const client = new HttpClient(ctx);
  expect((await client.signIn(users[key].email)).status).toBe(200);
  expect((await client.post('/api/auth/organization/set-active', { organizationId: tenantId })).status).toBe(
    200,
  );
  clients[key] = client;
}

// Las respuestas se leen como JSON sin tipar: los contratos los valida la API (zod) y el OpenAPI.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (response: { body?: unknown }): any => response.body;
const PERIOD = 'from=2026-10-05&to=2026-10-18';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stage = (block: any, key: string) => block.stages.find((item: { stage: string }) => item.stage === key);
const ids = (list: { items: { id: string }[] }) => list.items.map((item) => item.id).sort();
const sorted = (...convs: Conv[]) => convs.map((conv) => conv.conversationId).sort();

type PathKey = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'q';
const P = {} as Record<PathKey, Conv>;

beforeAll(async () => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  }
  ctx = await startTestContext();
  const boss = ctx.app.get<PgBoss>(BOSS);
  await boss.offWork(QUEUES.aiReply);
  await boss.offWork(QUEUES.whatsappOutbound);
  db = ctx.app.get<AppDatabase>(APP_DB);
  for (const k of ['owner', 'admin', 'seller', 'seller2', 'viewer', 'ownerB'] as const) {
    users[k] = await createUser(ctx, `funnel-${k}`);
  }
  tenantA = await createTenant(ctx, 'funnel-a', users.owner.id);
  tenantB = await createTenant(ctx, 'funnel-b', users.ownerB.id);
  tenantC = await createTenant(ctx, 'funnel-c', users.owner.id);
  await addMember(ctx, tenantA, users.admin.id, 'admin');
  await addMember(ctx, tenantA, users.seller.id, 'seller');
  await addMember(ctx, tenantA, users.seller2.id, 'seller');
  await addMember(ctx, tenantA, users.viewer.id, 'viewer');
  channels.A1 = await createChannel(tenantA, users.owner.id, 'Ventas');
  channels.A2 = await createChannel(tenantA, users.owner.id, 'Sucursal');
  channels.A3 = await createChannel(tenantA, users.owner.id, 'Mayorista');
  channels.B1 = await createChannel(tenantB, users.ownerB.id, 'Ventas B');
  channels.C1 = await createChannel(tenantC, users.owner.id, 'Ventas C');
  for (const k of ['owner', 'admin', 'seller', 'seller2', 'viewer'] as const) await login(k, tenantA);
  await login('ownerB', tenantB);
  for (const [channel, members] of [
    ['A1', [users.seller.id]],
    ['A2', [users.seller.id, users.seller2.id]],
  ] as const) {
    const response = await clients.owner.request('PUT', `/api/channels/${channels[channel].id}/members`, {
      userIds: members,
    });
    expect(response.status).toBe(200);
  }
  await setConfig(tenantA, configFor([channels.A1.id, channels.A2.id, channels.A3.id]));
  await setConfig(tenantB, configFor([channels.B1.id]));

  // a: escribió y se cerró sin respuesta (perdida en 1).
  P.a = await path({ at: '2026-10-05T11:00', close: { at: '2026-10-06T11:00', outcome: 'no_response' } });
  // b: fría y en curso.
  P.b = await path({ at: '2026-10-05T12:00', tier: 'cold' });
  // c: tibia, no compró (perdida en 2).
  P.c = await path({
    at: '2026-10-06T10:00',
    tier: 'warm',
    close: { at: '2026-10-07T10:00', outcome: 'not_sold' },
  });
  // d: caliente, cerrada "otro" sin derivar (perdida en 3).
  P.d = await path({
    at: '2026-10-06T11:00',
    tier: 'hot',
    close: { at: '2026-10-07T11:00', outcome: 'other' },
  });
  // e: caliente, derivada el viernes 17:50 → lunes 9:10 (10 + 10 min), sin respuesta y en curso.
  P.e = await path({ at: '2026-10-09T17:50', tier: 'hot', score: 90, handoff: '2026-10-12T09:10' });
  // f: caliente, derivada, atendida por seller, no compró (perdida en 5).
  P.f = await path({
    at: '2026-10-07T10:00',
    tier: 'hot',
    handoff: '2026-10-07T10:05',
    human: { at: '2026-10-07T10:20', by: 'seller' },
    close: { at: '2026-10-08T10:00', outcome: 'not_sold' },
  });
  // g: el camino completo, con monto.
  P.g = await path({
    at: '2026-10-05T10:00',
    tier: 'hot',
    handoff: '2026-10-05T10:30',
    human: { at: '2026-10-05T10:45', by: 'seller' },
    close: { at: '2026-10-06T10:00', outcome: 'sold', amount: '100000.00' },
  });
  // h: tibia, atendida sin derivar (desde el teléfono: atribuida al único vendedor) y vendida sin caliente.
  P.h = await path({
    at: '2026-10-06T10:00',
    tier: 'warm',
    human: { at: '2026-10-06T10:30', by: null },
    close: { at: '2026-10-06T12:00', outcome: 'sold' },
  });
  // i: caliente, la vendió la IA sola (sin derivar ni persona), con monto.
  P.i = await path({
    at: '2026-10-07T09:00',
    tier: 'hot',
    close: { at: '2026-10-07T09:30', outcome: 'sold', amount: '50000.50' },
  });
  // j: caliente, derivada y reactivada (la reactivación va en el test 2), en curso.
  P.j = await path({ at: '2026-10-08T11:00', tier: 'hot', score: 75, handoff: '2026-10-08T11:01' });
  // k: fría, no era un lead.
  P.k = await path({
    at: '2026-10-08T12:00',
    tier: 'cold',
    close: { at: '2026-10-08T13:00', outcome: 'not_a_lead' },
  });
  // l: tibia, cerrada por inactividad.
  P.l = await path({
    at: '2026-10-08T14:00',
    tier: 'warm',
    close: { at: '2026-10-09T14:00', outcome: 'auto_inactive' },
  });
  // m: domingo 11/10 a las 23:30 local (lunes 02:30 UTC): es de W1.
  P.m = await path({ at: '2026-10-11T23:30' });
  // n: W2, caliente, en curso.
  P.n = await path({ at: '2026-10-13T10:00', tier: 'hot', score: 80 });
  // o: fuera del período.
  P.o = await path({ at: '2026-10-20T10:00', tier: 'hot' });
  // q: A2 (dos vendedores), tibia, atendida desde el teléfono (no atribuible), en curso.
  P.q = await path({
    at: '2026-10-07T15:00',
    channel: 'A2',
    tier: 'warm',
    human: { at: '2026-10-07T15:30', by: null },
  });
  // Otra empresa, en el mismo período.
  const other = await createConversation(tenantB, channels.B1.id, ar('2026-10-06T10:00'));
  await ctx.ownerPool.query(`UPDATE conversations SET lead_tier_peak = 'hot' WHERE id = $1`, [
    other.conversationId,
  ]);
  await refresh(other);

  // Reactivación (test 2): con la API, como en el panel.
  const reactivated = await clients.owner.post(`/api/conversations/${P.j.conversationId}/reactivate-ai`, {});
  expect(reactivated.status).toBe(200);
  await refresh(P.j);
});

afterAll(async () => {
  await ctx?.close();
  vi.restoreAllMocks();
});

describe('1. etapas, conversión, atajos y salidas de la cohorte', () => {
  it('cuenta cada etapa con su definición exacta', async () => {
    const response = await clients.owner.get(`/api/funnel?${PERIOD}`);
    expect(response.status).toBe(200);
    const body = json(response);
    expect(body).toMatchObject({ timezone: TZ, from: '2026-10-05', to: '2026-10-18', weeks: null });
    const total = body.total;
    // Cohorte: a b c d e f g h i j k l m n q = 15 (o queda afuera, la de B también).
    expect(total.stages.map((item: { stage: string; count: number }) => [item.stage, item.count])).toEqual([
      ['written', 15],
      ['qualified', 11], // c h l q (tibias) + d e f g i j n (calientes)
      ['hot', 7],
      ['handed_off', 4], // e f g j (j sigue contando después de reactivar)
      ['attended', 4], // f g h q
      ['sold', 3], // g h i
    ]);
    expect(stage(total, 'written')).toMatchObject({
      pctOfWritten: 100,
      reachedNext: 11,
      conversionToNext: 73.3,
      lostBeforeNext: 2, // a (sin respuesta) y k (no era un lead)
      openBeforeNext: 2, // b y m
    });
    expect(stage(total, 'qualified')).toMatchObject({
      reachedNext: 7,
      conversionToNext: 63.6,
      lostBeforeNext: 2, // c y l; h se vendió por un atajo: no es una pérdida
      openBeforeNext: 1, // q
    });
    expect(stage(total, 'hot')).toMatchObject({
      reachedNext: 4,
      conversionToNext: 57.1,
      lostBeforeNext: 1, // d (i se vendió sin derivar)
      openBeforeNext: 1, // n
    });
    expect(stage(total, 'handed_off')).toMatchObject({
      reachedNext: 2, // f g
      conversionToNext: 50,
      lostBeforeNext: 0,
      openBeforeNext: 2, // e j
    });
    expect(stage(total, 'attended')).toMatchObject({
      reachedNext: 2, // g h
      conversionToNext: 50,
      lostBeforeNext: 1, // f
      openBeforeNext: 1, // q
    });
    expect(stage(total, 'sold')).toMatchObject({
      pctOfWritten: 20,
      conversionToNext: null,
      lostBeforeNext: null,
      openBeforeNext: null,
    });
    expect(total.shortcuts).toEqual({ attendedWithoutHandoff: 2, soldWithoutHot: 1, soldAiOnly: 1 });
    expect(total.exits).toEqual({
      lost: { not_sold: 2, no_response: 1, other: 1, auto_inactive: 1 },
      notALead: 1,
      inProgress: 6, // b e j m n q
    });
    expect(total.hotLost).toEqual({ not_sold: 1, no_response: 0, other: 1, auto_inactive: 0 });
    expect(total.handedOffUnanswered).toBe(2); // e j
  });

  it('excludeNotALead saca a k de toda la cohorte', async () => {
    const total = json(await clients.owner.get(`/api/funnel?${PERIOD}&excludeNotALead=true`)).total;
    expect(stage(total, 'written')).toMatchObject({ count: 14, lostBeforeNext: 1 });
    expect(total.exits.notALead).toBe(0);
  });

  it('filtra por número y por nivel máximo', async () => {
    const a2 = json(await clients.owner.get(`/api/funnel?${PERIOD}&channelId=${channels.A2.id}`)).total;
    expect(stage(a2, 'written').count).toBe(1);
    const hot = json(await clients.owner.get(`/api/funnel?${PERIOD}&tier=hot`)).total;
    expect(stage(hot, 'written').count).toBe(7);
    expect(stage(hot, 'sold').count).toBe(2); // g i
  });

  it('por vendedor: solo las atribuibles, con el aviso de las que no se pueden atribuir', async () => {
    const body = json(await clients.owner.get(`/api/funnel?${PERIOD}&userId=${users.seller.id}`));
    // f y g (desde el panel) y h (teléfono, el número tiene un solo vendedor). q no se puede atribuir.
    expect(stage(body.total, 'written').count).toBe(3);
    expect(stage(body.total, 'sold').count).toBe(2);
    expect(body.unattributed).toBe(1);
    expect(body.options.sellers.map((seller: { id: string }) => seller.id)).toContain(users.seller.id);
    // El viewer no filtra por vendedor (como en Rendimiento).
    expect((await clients.viewer.get(`/api/funnel?${PERIOD}&userId=${users.seller.id}`)).status).toBe(400);
  });
});

describe('2. reactivar la IA no borra la derivación', () => {
  it('después de reactivar, conversations.handed_off_at vuelve a NULL y el embudo la sigue contando', async () => {
    const { rows } = await ctx.ownerPool.query(
      `SELECT c.handed_off_at AS conversation, cm.handed_off_at AS metrics
       FROM conversations c JOIN conversation_metrics cm ON cm.conversation_id = c.id WHERE c.id = $1`,
      [P.j.conversationId],
    );
    expect(rows[0].conversation).toBeNull();
    expect(rows[0].metrics).toEqual(ar('2026-10-08T11:01'));
    const list = json(await clients.owner.get(`/api/funnel/leads?${PERIOD}&stage=handed_off`));
    expect(ids(list)).toEqual(sorted(P.e, P.f, P.g, P.j));
  });
});

function aiService(fake: FakeLlm) {
  return new AiReplyService(
    { ...ctx.env, AI_ENABLED: true },
    db,
    new FakeLlmFactory(fake),
    new NoopBudgetGuard(),
    configs,
    ctx.app.get(OutboundService),
    new FakePresence() as unknown as PresenceService,
    ctx.app.get(CatalogService),
    ctx.app.get(CatalogRefreshWorker),
  );
}

describe('3. umbrales: el nivel máximo se guarda en el momento', () => {
  it('el worker de la IA guarda caliente; subir el umbral no lo recalcula (ni en las métricas)', async () => {
    const conv = await createConversation(tenantA, channels.A3.id, new Date());
    const fake = new FakeLlm();
    const config = testConfig();
    // Señales en 5 y sin campos obligatorios: puntaje 80 (8 de 10).
    fake.respond = () => agentOutput(config, { signals: signals(config, 5) });
    const first = await withTenant(ctx, tenantA, (c) =>
      c.query<{ id: string }>(`SELECT id FROM messages WHERE conversation_id = $1`, [conv.conversationId]),
    );
    await aiService(fake).process({
      tenantId: tenantA,
      conversationId: conv.conversationId,
      messageId: first.rows[0]!.id,
    });
    const tierOf = async () =>
      (
        await ctx.ownerPool.query(
          `SELECT c.lead_score, c.lead_tier, c.lead_tier_peak, cm.lead_tier_peak AS metrics_peak
           FROM conversations c JOIN conversation_metrics cm ON cm.conversation_id = c.id WHERE c.id = $1`,
          [conv.conversationId],
        )
      ).rows[0];
    expect(await tierOf()).toEqual({
      lead_score: 80,
      lead_tier: 'hot',
      lead_tier_peak: 'hot',
      metrics_peak: 'hot',
    });

    // La empresa sube el umbral de caliente a 95: el mismo puntaje ahora es tibio.
    const base = configFor([channels.A1.id, channels.A2.id, channels.A3.id]);
    await setConfig(tenantA, { ...base, scoring: { ...base.scoring!, thresholds: { hot: 95, warm: 40 } } });
    const second = await insertMessage(conv, 'contact', new Date(), 'Otra consulta');
    await aiService(fake).process({
      tenantId: tenantA,
      conversationId: conv.conversationId,
      messageId: second,
    });
    await refresh(conv);
    expect(await tierOf()).toEqual({
      lead_score: 80,
      lead_tier: 'warm',
      lead_tier_peak: 'hot',
      metrics_peak: 'hot',
    });
    // Las conversaciones viejas tampoco cambian al recalcular sus métricas.
    await refresh(P.n);
    const { rows } = await ctx.ownerPool.query(
      'SELECT lead_tier_peak FROM conversation_metrics WHERE conversation_id = $1',
      [P.n.conversationId],
    );
    expect(rows[0].lead_tier_peak).toBe('hot');
    await setConfig(tenantA, base);
  });
});

describe('4. cohortes semanales', () => {
  it('el domingo 23:30 local cae en su semana; con groupBy=week, una cohorte por lunes', async () => {
    const body = json(await clients.owner.get(`/api/funnel?${PERIOD}&groupBy=week`));
    expect(body.weeks.map((week: { weekStart: string }) => week.weekStart)).toEqual([
      '2026-10-05',
      '2026-10-12',
    ]);
    expect(stage(body.weeks[0].block, 'written').count).toBe(14); // todas menos n (m incluida)
    expect(stage(body.weeks[1].block, 'written').count).toBe(1); // n
    const sundayOnly = json(await clients.owner.get('/api/funnel?from=2026-10-11&to=2026-10-11')).total;
    expect(stage(sundayOnly, 'written').count).toBe(1);
  });

  it('valida el período: más de 26 semanas con groupBy=week o más de 366 días → 400', async () => {
    expect(weeksOf({ from: '2026-10-05', to: '2026-10-18' })).toEqual(['2026-10-05', '2026-10-12']);
    expect((await clients.owner.get('/api/funnel?from=2026-01-01&to=2026-10-18&groupBy=week')).status).toBe(
      400,
    );
    expect((await clients.owner.get('/api/funnel?from=2024-01-01&to=2026-10-18')).status).toBe(400);
    expect((await clients.owner.get('/api/funnel?from=2026-10-18&to=2026-10-05')).status).toBe(400);
  });
});

describe('5. tiempos en horario de atención', () => {
  it('coinciden con businessSecondsBetween, incluido el fin de semana', async () => {
    const seconds = (from: string, to: string) => businessSecondsBetween(ar(from), ar(to), WEEKDAYS, TZ);
    // Escribió → derivado: g 30 min, f 5 min, j 1 min y e del viernes 17:50 al lunes 9:10 (10 + 10 min).
    expect(seconds('2026-10-09T17:50', '2026-10-12T09:10')).toBe(1200);
    const toHandoff = [1800, 300, 60, 1200].sort((x, y) => x - y);
    expect([
      seconds('2026-10-05T10:00', '2026-10-05T10:30'),
      seconds('2026-10-07T10:00', '2026-10-07T10:05'),
    ]).toEqual([1800, 300]);
    const times = json(await clients.owner.get(`/api/funnel?${PERIOD}`)).total.times;
    // percentile_cont sobre [60, 300, 1200, 1800]: p50 = 750; p90 = 1200 + 0,7 × 600 = 1620.
    expect(toHandoff).toEqual([60, 300, 1200, 1800]);
    expect(times.toHandoff).toEqual({ p50Seconds: 750, p90Seconds: 1620, count: 4 });
    // Derivado → atendido: g y f, 15 min cada una (e y j no tienen respuesta).
    expect(times.handoffToAttended).toEqual({ p50Seconds: 900, p90Seconds: 900, count: 2 });
    // Escribió → vendido: i 30 min, h 2 h, g del lunes 10:00 al martes 10:00 = 8 h + 1 h.
    expect(seconds('2026-10-05T10:00', '2026-10-06T10:00')).toBe(32_400);
    // p50 = 7200; p90 = 7200 + 0,8 × 25 200 = 27 360.
    expect(times.toSold).toEqual({ p50Seconds: 7200, p90Seconds: 27_360, count: 3 });
  });
});

describe('6. montos', () => {
  it('total y promedio solo con las ventas que tienen monto, con el conteo', async () => {
    const amounts = json(await clients.owner.get(`/api/funnel?${PERIOD}`)).total.amounts;
    expect(amounts).toEqual({ total: '150000.50', average: '75000.25', withAmount: 2, sold: 3 });
  });

  it('el cierre guarda el monto solo con "vendido" y lo valida', async () => {
    const conv = await createConversation(tenantA, channels.A3.id, new Date());
    const close = (body: unknown) =>
      clients.owner.post(`/api/conversations/${conv.conversationId}/close`, body);
    for (const amount of ['0', '-5', '1.234', 'abc', '1e5', '1234567890123']) {
      expect((await close({ outcome: 'sold', amount })).status).toBe(400);
    }
    expect((await close({ outcome: 'not_sold', amount: '100' })).status).toBe(400);
    expect((await close({ outcome: 'sold', amount: '1500.5' })).status).toBe(200);
    const { rows } = await ctx.ownerPool.query(
      `SELECT c.close_amount, cm.close_amount AS metrics_amount
       FROM conversations c JOIN conversation_metrics cm ON cm.conversation_id = c.id WHERE c.id = $1`,
      [conv.conversationId],
    );
    expect(rows[0]).toEqual({ close_amount: '1500.50', metrics_amount: '1500.50' });
    // Sin monto, "vendido" también se puede cerrar; y la base no acepta un monto sin "vendido".
    const plain = await createConversation(tenantA, channels.A3.id, new Date());
    expect(
      (await clients.owner.post(`/api/conversations/${plain.conversationId}/close`, { outcome: 'sold' }))
        .status,
    ).toBe(200);
    await expect(
      ctx.ownerPool.query(
        `UPDATE conversations SET close_outcome = 'not_sold', close_amount = 10 WHERE id = $1`,
        [plain.conversationId],
      ),
    ).rejects.toThrow(/conversations_close_amount_check/);
  });
});

describe('7. listas', () => {
  it('funnel/leads por etapa, por pérdida y por salida devuelve exactamente las esperadas', async () => {
    const list = (query: string) => clients.owner.get(`/api/funnel/leads?${PERIOD}&${query}`);
    const hot = json(await list('stage=hot'));
    expect(hot).toMatchObject({ total: 7, page: 0, pageSize: 25 });
    expect(ids(hot)).toEqual(sorted(P.d, P.e, P.f, P.g, P.i, P.j, P.n));
    // Mismas columnas que la grilla (LeadRow).
    expect(hot.items[0]).toHaveProperty('contact');
    expect(hot.items[0]).toHaveProperty('lastMessage');
    expect(ids(json(await list('stage=written&dropped=true')))).toEqual(sorted(P.a, P.k));
    expect(ids(json(await list('stage=qualified&dropped=true')))).toEqual(sorted(P.c, P.l));
    expect(ids(json(await list('stage=hot&dropped=true')))).toEqual(sorted(P.d));
    expect(json(await list('stage=handed_off&dropped=true')).total).toBe(0);
    expect(ids(json(await list('stage=attended&dropped=true')))).toEqual(sorted(P.f));
    expect(ids(json(await list('outcome=not_sold')))).toEqual(sorted(P.c, P.f));
    expect(ids(json(await list('outcome=open')))).toEqual(sorted(P.b, P.e, P.j, P.m, P.n, P.q));
    expect(ids(json(await list('stage=hot&outcome=not_sold')))).toEqual(sorted(P.f));
    expect((await list('stage=sold&dropped=true')).status).toBe(400);
    expect((await list('dropped=true')).status).toBe(400);
    expect((await list('stage=nope')).status).toBe(400);
    // Paginada.
    const page = json(await list('stage=hot&pageSize=3&page=1'));
    expect(page).toMatchObject({ total: 7, page: 1, pageSize: 3 });
    expect(page.items).toHaveLength(3);
  });

  it('funnel/stalled respeta los días y el orden (puntaje, después el que lleva más sin mensajes)', async () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    const stalled = async (days: number, score: number, tier: string, closed = false) => {
      const conv = await createConversation(tenantA, channels.A3.id, daysAgo(days));
      await ctx.ownerPool.query(
        `UPDATE conversations SET lead_tier_peak = $2, lead_score = $3,
           status = CASE WHEN $4 THEN 'closed' ELSE status END,
           closed_at = CASE WHEN $4 THEN now() END, close_outcome = CASE WHEN $4 THEN 'other' END
         WHERE id = $1`,
        [conv.conversationId, tier, score, closed],
      );
      return conv;
    };
    const s1 = await stalled(5, 90, 'hot');
    const s2 = await stalled(10, 95, 'hot');
    const s3 = await stalled(8, 90, 'hot'); // mismo puntaje que s1, más tiempo sin mensajes
    await stalled(1, 99, 'hot'); // reciente
    await stalled(10, 99, 'warm'); // no llegó a caliente
    await stalled(10, 99, 'hot', true); // cerrada
    const query = (days: number) =>
      clients.owner.get(`/api/funnel/stalled?channelId=${channels.A3.id}&days=${days}`);
    const body = json(await query(3));
    expect(body.days).toBe(3);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(
      [s2, s3, s1].map((conv) => conv.conversationId),
    );
    expect(json(await query(7)).items.map((item: { id: string }) => item.id)).toEqual(
      [s2, s3].map((conv) => conv.conversationId),
    );
    expect(json(await clients.owner.get(`/api/funnel/stalled?channelId=${channels.A3.id}`)).days).toBe(3);
    expect((await query(0)).status).toBe(400);
    expect((await query(31)).status).toBe(400);
  });
});

describe('8. permisos y aislamiento', () => {
  it('seller → 403; viewer ve el embudo (todos los números) pero no las listas; admin ve todo', async () => {
    expect((await clients.seller.get(`/api/funnel?${PERIOD}`)).status).toBe(403);
    expect((await clients.seller.get(`/api/funnel/leads?${PERIOD}&stage=hot`)).status).toBe(403);
    expect((await clients.seller.get('/api/funnel/stalled')).status).toBe(403);
    const viewer = await clients.viewer.get(`/api/funnel?${PERIOD}`);
    expect(viewer.status).toBe(200);
    expect(stage(json(viewer).total, 'written').count).toBe(15);
    expect(json(viewer).options.sellers).toBeNull();
    expect((await clients.viewer.get(`/api/funnel/leads?${PERIOD}&stage=hot`)).status).toBe(403);
    expect((await clients.viewer.get('/api/funnel/stalled')).status).toBe(403);
    expect(stage(json(await clients.admin.get(`/api/funnel?${PERIOD}`)).total, 'written').count).toBe(15);
  });

  it('la empresa B no ve nada de la A (ni con el número de A en el filtro)', async () => {
    const own = json(await clients.ownerB.get(`/api/funnel?${PERIOD}`));
    expect(stage(own.total, 'written').count).toBe(1);
    expect(stage(own.total, 'hot').count).toBe(1);
    const foreign = json(await clients.ownerB.get(`/api/funnel?${PERIOD}&channelId=${channels.A1.id}`));
    expect(stage(foreign.total, 'written').count).toBe(0);
    const leads = json(await clients.ownerB.get(`/api/funnel/leads?${PERIOD}&channelId=${channels.A1.id}`));
    expect(leads.total).toBe(0);
  });

  it('un rol con visibilidad por número que tuviera metrics.read ve solo sus números', async () => {
    // Ningún rol de hoy lo tiene: se llama al servicio con un seller (ConversationScope: solo A1 y A2) y una
    // empresa que solo le asignó A2 a seller2.
    const service = ctx.app.get(FunnelService);
    const forSeller2 = await withTenantTransaction(
      db.db,
      { tenantId: tenantA, userId: users.seller2.id },
      (tx) =>
        service.funnel(
          tx,
          { tenantId: tenantA, userId: users.seller2.id, role: 'seller' },
          { from: '2026-10-05', to: '2026-10-18', groupBy: 'total' },
        ),
    );
    expect(stage(forSeller2.total, 'written').count).toBe(1); // q (A2)
    expect(forSeller2.options.channels.map((channel) => channel.id)).toEqual([channels.A2.id]);
  });
});

describe('9. backfill', () => {
  it('completa lead_tier_peak con los umbrales de cada versión y la primera derivación, sin duplicar', async () => {
    // Empresa C: versión 1 con caliente desde 70; versión 2, desde 95.
    const base = configFor([channels.C1.id]);
    await setConfig(tenantC, base);
    await setConfig(tenantC, { ...base, scoring: { ...base.scoring!, thresholds: { hot: 95, warm: 50 } } });
    const versions = (
      await ctx.ownerPool.query<{ version: number }>(
        'SELECT version FROM tenant_configs WHERE tenant_id = $1 ORDER BY version',
        [tenantC],
      )
    ).rows.map((row) => row.version);
    const old = await createConversation(tenantC, channels.C1.id, ar('2026-09-01T10:00'));
    const message = (
      await ctx.ownerPool.query<{ id: string }>('SELECT id FROM messages WHERE conversation_id = $1', [
        old.conversationId,
      ])
    ).rows[0]!.id;
    const run = (score: number | null, version: number, decision: string, at: string) =>
      ctx.ownerPool.query(
        `INSERT INTO ai_runs (tenant_id, conversation_id, trigger_message_id, prompt_version, config_version,
           score, decision, created_at)
         VALUES ($1, $2, $3, 'v1', $4, $5, $6, $7)`,
        [tenantC, old.conversationId, message, version, score, decision, ar(at)],
      );
    await run(80, versions[0]!, 'replied', '2026-09-01T10:01'); // caliente con la versión 1
    await run(80, versions[1]!, 'replied', '2026-09-02T10:01'); // tibio con la versión 2
    await run(null, versions[1]!, 'handed_off', '2026-09-03T10:00');
    // Derivada antes, reactivada (el evento guarda la derivación previa) y hoy sin derivar.
    await ctx.ownerPool.query(
      `INSERT INTO conversation_events (tenant_id, conversation_id, type, data)
       VALUES ($1, $2, 'ai_reactivated', $3::jsonb)`,
      [tenantC, old.conversationId, JSON.stringify({ previous_handed_off_at: ar('2026-09-02T09:00') })],
    );
    await ctx.ownerPool.query('UPDATE conversations SET lead_score_peak = 80 WHERE id = $1', [
      old.conversationId,
    ]);
    // Sin corridas de la IA: el último nivel que calculó el worker (con los umbrales de ese momento).
    const noRuns = await createConversation(tenantC, channels.C1.id, ar('2026-09-01T10:30'));
    await ctx.ownerPool.query(
      `UPDATE conversations SET lead_tier = 'warm', lead_score_peak = 99 WHERE id = $1`,
      [noRuns.conversationId],
    );
    // Otra con el nivel ya guardado: no se toca.
    const kept = await createConversation(tenantC, channels.C1.id, ar('2026-09-01T11:00'));
    await ctx.ownerPool.query(
      `UPDATE conversations SET lead_tier_peak = 'warm', lead_score_peak = 99 WHERE id = $1`,
      [kept.conversationId],
    );

    const backfill = (conv: Conv) =>
      withTenantTransaction(db.db, { tenantId: tenantC }, (tx) =>
        backfillFunnelConversation(tx, conv.conversationId),
      );
    expect(await backfill(old)).toEqual({ tierFilled: true, handoffMoved: true });
    expect(await backfill(kept)).toEqual({ tierFilled: false, handoffMoved: false });
    expect(await backfill(noRuns)).toEqual({ tierFilled: true, handoffMoved: false });
    const state = async () =>
      (
        await ctx.ownerPool.query(
          `SELECT c.id, c.lead_tier_peak, cm.lead_tier_peak AS metrics_peak, cm.handed_off_at
           FROM conversations c JOIN conversation_metrics cm ON cm.conversation_id = c.id
           WHERE c.tenant_id = $1 ORDER BY c.created_at`,
          [tenantC],
        )
      ).rows;
    const after = await state();
    expect(after).toEqual([
      {
        id: old.conversationId,
        lead_tier_peak: 'hot',
        metrics_peak: 'hot',
        handed_off_at: ar('2026-09-02T09:00'),
      },
      { id: noRuns.conversationId, lead_tier_peak: 'warm', metrics_peak: 'warm', handed_off_at: null },
      { id: kept.conversationId, lead_tier_peak: 'warm', metrics_peak: 'warm', handed_off_at: null },
    ]);
    // Dos veces: nada cambia.
    expect(await backfill(old)).toEqual({ tierFilled: false, handoffMoved: false });
    expect(await state()).toEqual(after);
    expect(highestTier([null, 'cold', 'hot', 'warm'])).toBe('hot');
    expect(highestTier([null])).toBeNull();
  });
});

describe('11. logs', () => {
  it('sin textos del cliente ni teléfonos', () => {
    const all = logged.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toMatch(/\+\d{10,}/);
  });
});
