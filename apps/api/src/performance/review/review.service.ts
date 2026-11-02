// Analista de calidad (tarea 026). Revisa con un modelo las conversaciones con participación del equipo y
// guarda una revisión con las citas verificadas por el código. Mismo esquema que ai-reply: T1 lee, el
// modelo corre fuera de toda transacción y T2 inserta. Nunca loguea texto de mensajes ni citas.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { REVIEW_DEFAULT_MODEL_ID, type TenantConfig } from '@ventas/shared';
import { sql } from 'drizzle-orm';
import { TenantConfigService } from '../../ai/config/tenant-config.service.js';
import { AI_BUDGET_GUARD, type AiBudgetGuard } from '../../ai/llm/budget-guard.js';
import {
  LLM_CLIENT_FACTORY,
  type LlmClientFactory,
  type LlmSelection,
} from '../../ai/llm/llm-client.factory.js';
import { LlmError, type LlmRequest } from '../../ai/llm/llm-client.js';
import { addUsd, tokensCostUsd } from '../../ai/llm/money.js';
import { localTime } from '../../ai/reply/business-hours.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { APP_DB, type AppDatabase } from '../../db/database.module.js';
import { withTenantTransaction, type AppTx } from '../../db/tenant-context.js';
import {
  buildDigestPrompt,
  buildDigestSchema,
  DIGEST_MAX_OUTPUT_TOKENS,
  DIGEST_MAX_REVIEWS,
  DIGEST_PROMPT_VERSION,
  type DigestOutput,
  type DigestReviewInput,
} from './digest-v1.js';
import { validateReview } from './evidence.js';
import {
  buildReviewPrompt,
  buildReviewSchema,
  prepareReviewMessages,
  REVIEW_MAX_OUTPUT_TOKENS,
  REVIEW_PROMPT_VERSION,
  type ReviewAuthor,
  type ReviewMessage,
  type ReviewOutput,
} from './prompt-v1.js';

/** Sin mensajes nuevos en este tiempo, una conversación abierta ya se puede revisar. */
export const REVIEW_QUIET_HOURS = 24;

const AUTHOR: Record<string, ReviewAuthor> = {
  contact: 'cliente',
  user: 'equipo',
  ai: 'asistente',
  app: 'sistema',
};

export type ReviewResult =
  | { status: 'reviewed'; reviewId: string; discarded: number; costUsd: string }
  | {
      status: 'skipped';
      reason: 'disabled' | 'no_config' | 'not_found' | 'no_human' | 'up_to_date' | 'daily_cap';
    }
  | { status: 'error'; reason: 'model_unavailable' | 'budget' | `llm_${string}` };

interface Loaded {
  config: TenantConfig;
  configVersion: number;
  timezone: string;
}

/** Conversaciones pendientes de revisión: cerradas o quietas, con un humano y sin revisar desde su último mensaje. */
const PENDING_REVIEW = sql`
  (c.status = 'closed' OR c.last_message_at < now() - make_interval(hours => ${REVIEW_QUIET_HOURS}))
  AND EXISTS (SELECT 1 FROM messages h WHERE h.conversation_id = c.id AND h.sender_type = 'user')
  AND NOT EXISTS (
    SELECT 1 FROM conversation_reviews r WHERE r.conversation_id = c.id AND r.last_message_at >= c.last_message_at
  )`;

@Injectable()
export class ReviewService {
  private readonly logger = new Logger('ReviewService');

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_DB) private readonly database: AppDatabase,
    @Inject(LLM_CLIENT_FACTORY) private readonly llm: LlmClientFactory,
    @Inject(AI_BUDGET_GUARD) private readonly budget: AiBudgetGuard,
    private readonly configs: TenantConfigService,
  ) {}

  /** Revisa hasta lo que queda del tope diario (review.max_per_day, por día local de la empresa). */
  async runForTenant(tenantId: string): Promise<{ reviewed: number; attempted: number }> {
    const plan = await withTenantTransaction(this.database.db, { tenantId }, async (tx) => {
      const loaded = await this.load(tx);
      if (!loaded || !this.enabled(loaded.config)) return null;
      const remaining = loaded.config.review.max_per_day - (await this.reviewedToday(tx, loaded.timezone));
      if (remaining <= 0) return null;
      const due = await tx.execute<{ id: string }>(sql`
        SELECT c.id FROM conversations c WHERE ${PENDING_REVIEW}
        ORDER BY c.last_message_at DESC, c.id LIMIT ${remaining}
      `);
      return due.rows.map((row) => row.id);
    });
    if (!plan) return { reviewed: 0, attempted: 0 };
    let reviewed = 0;
    for (const conversationId of plan) {
      const result = await this.reviewConversation(tenantId, conversationId);
      if (result.status === 'reviewed') reviewed++;
      // Sin presupuesto o sin modelo, el resto tampoco va a andar hoy.
      if (result.status === 'error' && (result.reason === 'budget' || result.reason === 'model_unavailable'))
        break;
    }
    return { reviewed, attempted: plan.length };
  }

  /** Revisa una conversación (también la usa npm run dev:review). Respeta enabled y el tope diario. */
  async reviewConversation(tenantId: string, conversationId: string): Promise<ReviewResult> {
    // ---- T1 ----
    const first = await withTenantTransaction(this.database.db, { tenantId }, async (tx) => {
      const loaded = await this.load(tx);
      if (!loaded)
        return { kind: 'done' as const, done: { status: 'skipped', reason: 'no_config' } as ReviewResult };
      if (!this.enabled(loaded.config))
        return { kind: 'done' as const, done: { status: 'skipped', reason: 'disabled' } as ReviewResult };
      if ((await this.reviewedToday(tx, loaded.timezone)) >= loaded.config.review.max_per_day)
        return { kind: 'done' as const, done: { status: 'skipped', reason: 'daily_cap' } as ReviewResult };
      const conversation = await tx.execute<{
        channel_id: string;
        last_message_id: string | null;
        last_message_at: Date | null;
        has_human: boolean;
        reviewed: boolean;
        attributed_user_id: string | null;
      }>(sql`
        SELECT c.channel_id, lm.id AS last_message_id, lm.sent_at AS last_message_at,
          EXISTS (SELECT 1 FROM messages h WHERE h.conversation_id = c.id AND h.sender_type = 'user') AS has_human,
          EXISTS (SELECT 1 FROM conversation_reviews r WHERE r.conversation_id = c.id
                  AND r.last_message_at >= lm.sent_at) AS reviewed,
          m.attributed_user_id
        FROM conversations c
        LEFT JOIN LATERAL (
          SELECT x.id, x.sent_at FROM messages x WHERE x.conversation_id = c.id
          ORDER BY x.sent_at DESC, x.id DESC LIMIT 1
        ) lm ON true
        LEFT JOIN conversation_metrics m ON m.conversation_id = c.id
        WHERE c.id = ${conversationId}
      `);
      const row = conversation.rows[0];
      if (!row || !row.last_message_id)
        return { kind: 'done' as const, done: { status: 'skipped', reason: 'not_found' } as ReviewResult };
      if (!row.has_human)
        return { kind: 'done' as const, done: { status: 'skipped', reason: 'no_human' } as ReviewResult };
      if (row.reviewed)
        return { kind: 'done' as const, done: { status: 'skipped', reason: 'up_to_date' } as ReviewResult };
      const messages = await tx.execute<{
        id: string;
        sender_type: string;
        body: string | null;
        sent_at: Date;
      }>(sql`
        SELECT x.id, x.sender_type, x.body, x.sent_at FROM messages x
        WHERE x.conversation_id = ${conversationId} AND x.sent_at <= ${row.last_message_at}
        ORDER BY x.sent_at, x.id
      `);
      const withText = messages.rows.filter((message) => message.body?.trim());
      const prepared = prepareReviewMessages(
        withText.map((message) => {
          const local = localTime(new Date(message.sent_at), loaded.timezone);
          return {
            author: AUTHOR[message.sender_type] ?? 'sistema',
            at: `${local.date} ${local.time}`,
            text: message.body,
          };
        }),
      );
      // prepareReviewMessages se queda con los últimos: los ids van alineados con esa cola.
      const ids = withText.slice(-prepared.length).map((message) => message.id);
      return { kind: 'call' as const, loaded, row, prepared, ids };
    });
    if (first.kind === 'done') return first.done;
    const { loaded, row, prepared, ids } = first;
    if (!prepared.some((message) => message.author === 'equipo'))
      return { status: 'skipped', reason: 'no_human' };

    // ---- Modelo (fuera de toda transacción) ----
    const call = await this.callModel(
      tenantId,
      loaded.config,
      buildReviewPrompt(loaded.config.review, prepared),
      {
        schema: buildReviewSchema(loaded.config.review),
        maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS,
      },
    );
    if (call.kind !== 'ok') return { status: 'error', reason: call.reason };

    const { review, discarded } = validateReview(call.parsed, prepared);
    const stored = withMessageIds(review, ids);

    // ---- T2 ----
    // Si la T2 falla, el modelo ya cobró: se liquida igual y el error sigue (el trabajo se reintenta).
    let reviewId: string | null;
    try {
      reviewId = await withTenantTransaction(this.database.db, { tenantId }, async (tx) => {
        const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO conversation_reviews (tenant_id, conversation_id, channel_id, last_message_id, last_message_at,
          prompt_version, config_version, model, cost_usd, customer_outcome, resolved, output, discarded,
          attributed_user_id)
        VALUES (app_tenant_id(), ${conversationId}, ${row.channel_id}, ${row.last_message_id}, ${row.last_message_at},
          ${REVIEW_PROMPT_VERSION}, ${loaded.configVersion}, ${call.model}, ${call.costUsd},
          ${review.customer_outcome.value}, ${review.resolved}, ${JSON.stringify(stored)}::jsonb,
          ${JSON.stringify(discarded)}::jsonb, ${row.attributed_user_id})
        ON CONFLICT (conversation_id, last_message_id) DO NOTHING
        RETURNING id
      `);
        return inserted.rows[0]?.id ?? null;
      });
    } catch (error) {
      await this.budget.settle(call.reservationId, call.costUsd, randomUUID());
      throw error;
    }
    await this.budget.settle(call.reservationId, call.costUsd, reviewId ?? randomUUID());
    // Otra corrida (el trabajo diario y dev:review a la vez) guardó la misma revisión primero.
    if (!reviewId) return { status: 'skipped', reason: 'up_to_date' };
    // Solo ids y contadores: nunca texto ni citas.
    this.logger.log({ msg: 'review', tenantId, conversationId, reviewId, discarded: discarded.length });
    return { status: 'reviewed', reviewId, discarded: discarded.length, costUsd: call.costUsd };
  }

  /**
   * Resumen de la semana anterior (lunes a domingo, hora local) por número, si review.weekly_digest está
   * activo y todavía no se hizo. Solo con revisiones no disputadas. Se arma desde el miércoles: las
   * conversaciones del domingo necesitan sus 24 h quietas y una corrida del analista para tener revisión.
   */
  async runWeeklyDigests(tenantId: string): Promise<{ created: number }> {
    const plan = await withTenantTransaction(this.database.db, { tenantId }, async (tx) => {
      const loaded = await this.load(tx);
      if (!loaded || !this.enabled(loaded.config) || !loaded.config.review.weekly_digest) return null;
      const tz = loaded.timezone;
      const channels = await tx.execute<{ channel_id: string; week_start: string }>(sql`
        WITH w AS (SELECT (date_trunc('week', (now() AT TIME ZONE ${tz}) - interval '2 days') - interval '7 days')::date AS week_start)
        SELECT ch.id AS channel_id, to_char(w.week_start, 'YYYY-MM-DD') AS week_start
        FROM channels ch CROSS JOIN w
        WHERE NOT EXISTS (
          SELECT 1 FROM review_digests d WHERE d.channel_id = ch.id AND d.week_start = w.week_start
        )
      `);
      return { loaded, channels: channels.rows };
    });
    if (!plan) return { created: 0 };
    let created = 0;
    for (const channel of plan.channels) {
      if (await this.digestChannel(tenantId, plan.loaded, channel.channel_id, channel.week_start)) created++;
    }
    return { created };
  }

  private async digestChannel(tenantId: string, loaded: Loaded, channelId: string, weekStart: string) {
    const tz = loaded.timezone;
    const data = await withTenantTransaction(this.database.db, { tenantId }, async (tx) => {
      const week = sql`(${weekStart}::date)::timestamp AT TIME ZONE ${tz}`;
      const reviews = await tx.execute<{ id: string; conversation_id: string; output: ReviewOutput }>(sql`
        SELECT DISTINCT ON (r.conversation_id) r.id, r.conversation_id, r.output
        FROM conversation_reviews r
        WHERE r.channel_id = ${channelId} AND r.last_message_at >= ${week}
          AND r.last_message_at < ${week} + interval '7 days'
          AND NOT EXISTS (SELECT 1 FROM conversation_review_disputes d WHERE d.review_id = r.id)
        ORDER BY r.conversation_id, r.created_at DESC
        LIMIT ${DIGEST_MAX_REVIEWS}
      `);
      const previous = await tx.execute<{ output: ReviewOutput }>(sql`
        SELECT DISTINCT ON (r.conversation_id) r.output
        FROM conversation_reviews r
        WHERE r.channel_id = ${channelId} AND r.last_message_at >= ${week} - interval '7 days'
          AND r.last_message_at < ${week}
          AND NOT EXISTS (SELECT 1 FROM conversation_review_disputes d WHERE d.review_id = r.id)
        ORDER BY r.conversation_id, r.created_at DESC
      `);
      return { reviews: reviews.rows, previous: previous.rows.map((row) => row.output) };
    });
    if (data.reviews.length === 0) return false;

    const inputs: DigestReviewInput[] = data.reviews.map((row, index) => ({
      index,
      customer_outcome: row.output.customer_outcome.value,
      resolved: row.output.resolved,
      criteria: Object.fromEntries(
        Object.entries(row.output.criteria).map(([key, value]) => [key, value.score]),
      ),
      issues: row.output.issues.map((issue) => ({ type: issue.type, description: issue.description })),
      highlights: row.output.highlights.map((highlight) => highlight.description),
      summary: row.output.summary,
    }));
    const averages = {
      this_week: criteriaAverages(data.reviews.map((row) => row.output)),
      previous_week: data.previous.length > 0 ? criteriaAverages(data.previous) : null,
    };
    const call = await this.callModel(tenantId, loaded.config, buildDigestPrompt(inputs, averages), {
      schema: buildDigestSchema(),
      maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS,
    });
    if (call.kind !== 'ok') return false;
    const parsed: DigestOutput = call.parsed;
    // Solo ejemplos que existen; el enlace lo arma el panel con el id.
    const examples = parsed.examples
      .filter((example) => data.reviews[example.review])
      .map((example) => ({
        conversationId: data.reviews[example.review]!.conversation_id,
        reviewId: data.reviews[example.review]!.id,
        why: example.why,
      }));
    const output = {
      improved: parsed.improved,
      frequentProblems: parsed.frequent_problems,
      examples,
      averages,
    };
    const id = await withTenantTransaction(this.database.db, { tenantId }, async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO review_digests (tenant_id, channel_id, week_start, prompt_version, model, cost_usd, reviews_count, output)
        VALUES (app_tenant_id(), ${channelId}, ${weekStart}, ${DIGEST_PROMPT_VERSION}, ${call.model}, ${call.costUsd},
          ${data.reviews.length}, ${JSON.stringify(output)}::jsonb)
        ON CONFLICT (tenant_id, channel_id, week_start) DO NOTHING
        RETURNING id
      `);
      return inserted.rows[0]?.id ?? null;
    });
    await this.budget.settle(call.reservationId, call.costUsd, id ?? randomUUID());
    return id !== null;
  }

  private enabled(config: TenantConfig): boolean {
    return this.env.AI_ENABLED && config.review.enabled;
  }

  private async load(tx: AppTx): Promise<Loaded | null> {
    const lookup = await this.configs.latest(tx);
    if (lookup.kind !== 'ok') return null;
    const tenant = await tx.execute<{ timezone: string }>(
      sql`SELECT timezone FROM tenants WHERE id = app_tenant_id()`,
    );
    return { config: lookup.config, configVersion: lookup.version, timezone: tenant.rows[0]!.timezone };
  }

  /** Revisiones hechas hoy (día local de la empresa). */
  private async reviewedToday(tx: AppTx, timezone: string): Promise<number> {
    const result = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM conversation_reviews
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}
    `);
    return result.rows[0]?.n ?? 0;
  }

  /** Llamada con reserva de presupuesto. Si cobró y falló, liquida igual. */
  private async callModel<T>(
    tenantId: string,
    config: TenantConfig,
    prompt: { system: string; messages: LlmRequest<T>['messages'] },
    options: { schema: LlmRequest<T>['schema']; maxOutputTokens: number },
  ): Promise<
    | { kind: 'ok'; parsed: T; costUsd: string; model: string; reservationId: string }
    | { kind: 'error'; reason: 'model_unavailable' | 'budget' | `llm_${string}` }
  > {
    let selection: LlmSelection;
    try {
      // El modelo de la revisión (review.model) o REVIEW_DEFAULT_MODEL_ID (no el del agente: ver evals:review).
      const model = config.review.model ?? REVIEW_DEFAULT_MODEL_ID;
      selection = await this.llm.forTenant(tenantId, { ...config, ai: { ...config.ai, model } });
    } catch {
      return { kind: 'error', reason: 'model_unavailable' };
    }
    const request: LlmRequest<T> = {
      model: selection.model.id,
      system: prompt.system,
      messages: prompt.messages,
      schema: options.schema,
      maxOutputTokens: options.maxOutputTokens,
      ...(selection.model.reasoningEffort ? { reasoningEffort: selection.model.reasoningEffort } : {}),
    };
    const chars =
      request.system.length + request.messages.reduce((total, message) => total + message.content.length, 0);
    const estimate = addUsd(
      tokensCostUsd(Math.ceil(chars / 3), selection.model.inputUsdPerMTok),
      tokensCostUsd(options.maxOutputTokens, selection.model.outputUsdPerMTok),
    );
    const reservation = await this.budget.reserve(tenantId, estimate);
    if (!reservation.ok) return { kind: 'error', reason: 'budget' };
    try {
      const result = await selection.client.complete(request);
      return {
        kind: 'ok',
        parsed: result.parsed,
        costUsd: result.costUsd,
        model: result.model,
        reservationId: reservation.reservationId,
      };
    } catch (error) {
      if (error instanceof LlmError) {
        if (error.charged)
          await this.budget.settle(reservation.reservationId, error.charged.costUsd, randomUUID());
        else await this.budget.release(reservation.reservationId);
        this.logger.warn({ msg: 'review-llm', tenantId, kind: error.kind });
        return { kind: 'error', reason: `llm_${error.kind}` };
      }
      await this.budget.release(reservation.reservationId);
      throw error;
    }
  }
}

/** Cada evidencia con el id del mensaje (para resaltar la cita en el panel). */
function withMessageIds(review: ReviewOutput, ids: string[]) {
  const map = <E extends { message: number; quote: string } | null>(evidence: E) =>
    evidence ? { ...evidence, messageId: ids[evidence.message] ?? null } : null;
  return {
    ...review,
    customer_outcome: { ...review.customer_outcome, evidence: map(review.customer_outcome.evidence) },
    criteria: Object.fromEntries(
      Object.entries(review.criteria).map(([key, value]) => [
        key,
        { ...value, evidence: map(value.evidence) },
      ]),
    ),
    issues: review.issues.map((issue) => ({ ...issue, evidence: map(issue.evidence) })),
    highlights: review.highlights.map((highlight) => ({ ...highlight, evidence: map(highlight.evidence) })),
  };
}

/** Promedio de cada criterio (sin los null), con un decimal. */
export function criteriaAverages(outputs: ReviewOutput[]): Record<string, number | null> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const output of outputs) {
    for (const [key, value] of Object.entries(output.criteria)) {
      const entry = sums.get(key) ?? { total: 0, count: 0 };
      if (value.score !== null) {
        entry.total += value.score;
        entry.count++;
      }
      sums.set(key, entry);
    }
  }
  return Object.fromEntries(
    [...sums].map(([key, { total, count }]) => [
      key,
      count > 0 ? Math.round((total / count) * 10) / 10 : null,
    ]),
  );
}

export type { ReviewMessage };
