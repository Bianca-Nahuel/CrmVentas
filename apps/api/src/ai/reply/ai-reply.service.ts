// Pipeline del agente (tarea 006), un trabajo de la cola ai-reply por entrante nuevo:
//   T1 (lock corto de la conversación): ¿hay un entrante más nuevo? → filtros → entrante sin texto →
//      historial y estado.
//   Fuera de toda transacción: reserva de presupuesto → llamada al modelo → liquidación.
//   T2 (lock de la conversación): los mismos filtros otra vez (alguien pudo responder, pausar o escribir
//      durante la llamada) → puntaje y decide() → conversación, ai_runs y envío, todo junto.
// La cola es singleton por conversación (una corrida activa a la vez) y el envío es idempotente por el
// entrante ('ai:' + messageId), así un reintento nunca manda dos veces.
// Logs: ids, decisión, puntaje, costo y latencia. Nunca el texto del cliente, el prompt ni la respuesta.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MessageType, TenantConfig } from '@ventas/shared';
import { sql } from 'drizzle-orm';
import { ENV } from '../../config/config.module.js';
import { AI_HISTORY_MESSAGES } from '../ai.constants.js';
import type { Env } from '../../config/env.js';
import { APP_DB, type AppDatabase } from '../../db/database.module.js';
import { aiRuns, type NewAiRun } from '../../db/schema/ai.js';
import { withTenantTransaction, type AppTx } from '../../db/tenant-context.js';
import { OutboundService } from '../../messaging/outbound/outbound.service.js';
import { PresenceService } from '../../messaging/outbound/presence.service.js';
import { TenantConfigService } from '../config/tenant-config.service.js';
import { AI_BUDGET_GUARD, type AiBudgetGuard } from '../llm/budget-guard.js';
import { LLM_CLIENT_FACTORY, type LlmClientFactory, type LlmSelection } from '../llm/llm-client.factory.js';
import { LlmError, type LlmResult } from '../llm/llm-client.js';
import { PROMPT_VERSION, type HistoryAuthor, type HistoryMessage } from '../prompts/v1/index.js';
import type { AgentOutput, DiscoveredNote, ExtractedValue } from '../prompts/v1/output-schema.js';
import type { TenantLayerState } from '../prompts/v1/tenant-layer.js';
import { tierFor } from '../scoring/score.js';
import type { AiReplyJob } from './ai-reply.job.js';
import { isOpenAt, localTime } from './business-hours.js';
import type { Decision } from './decide.js';
import { composeHandoffSummary } from './handoff-summary.js';
import type { SafeReply } from './output-checks.js';
import {
  evaluateTurn,
  prepareTurn,
  type PreparedTurn,
  type TurnEvaluation,
  type TurnInput,
} from './reply-engine.js';

/** Resultado para el log del worker. */
export type AiReplyOutcome = {
  decision: string;
  score?: number | null;
  costUsd?: string;
  latencyMs?: number;
  /** Se encoló un mensaje (respuesta o texto fijo) en esta corrida. */
  sent?: boolean;
};

type SkipReason =
  | 'ai_disabled'
  | 'tenant_suspended'
  | 'no_config'
  | 'invalid_config'
  | 'tenant_disabled'
  | 'channel_disabled'
  | 'conversation_closed'
  | 'inbox_other'
  | 'contact_blocked'
  | 'ai_paused'
  | 'handed_off'
  | 'last_not_client'
  | 'pending_outbound';

interface Snapshot {
  status: string;
  inbox: string;
  channelId: string;
  paused: boolean;
  handedOff: boolean;
  contactBlocked: boolean;
  timezone: string;
  tenantActive: boolean;
  latestInboundId: string | null;
  latestInboundType: MessageType | null;
  latestInboundHasText: boolean;
  lastDirection: string | null;
  pendingOutbound: boolean;
  extracted: Record<string, ExtractedValue>;
  discovered: DiscoveredNote[];
  leadScore: number | null;
  leadScorePeak: number | null;
  qualificationTurns: number;
  hotTurns: number;
  suggestionsCount: number;
}

type Loaded =
  | { kind: 'ok'; version: number; config: TenantConfig }
  | { kind: 'missing' }
  | { kind: 'invalid'; version: number };

const AUTHORS: Record<string, HistoryAuthor> = {
  contact: 'cliente',
  ai: 'asistente',
  user: 'vendedor',
  app: 'sistema',
};

/** Decisiones finales de un entrante: si ya hay una, un reintento del trabajo no vuelve a llamar al modelo. */
const FINAL_DECISION = sql`(decision IN ('replied', 'asked_fields', 'asked_text', 'handed_off', 'none') OR decision LIKE 'blocked:%' OR decision = 'error:invalid_output')`;

@Injectable()
export class AiReplyService {
  private readonly logger = new Logger('AiReply');

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_DB) private readonly database: AppDatabase,
    @Inject(LLM_CLIENT_FACTORY) private readonly llm: LlmClientFactory,
    @Inject(AI_BUDGET_GUARD) private readonly budget: AiBudgetGuard,
    private readonly configs: TenantConfigService,
    private readonly outbound: OutboundService,
    private readonly presence: PresenceService,
  ) {}

  async process(job: AiReplyJob): Promise<AiReplyOutcome> {
    const now = new Date();
    // ---- T1 ----
    const first = await withTenantTransaction(this.database.db, { tenantId: job.tenantId }, async (tx) => {
      const snapshot = await this.lockSnapshot(tx, job.conversationId);
      if (!snapshot) return { kind: 'done' as const, outcome: { decision: 'skipped:gone' } };
      // Debounce: lo procesa el trabajo del entrante más nuevo. Sin fila en ai_runs.
      if (snapshot.latestInboundId !== job.messageId) {
        return { kind: 'done' as const, outcome: { decision: 'skipped:superseded' } };
      }
      if (await this.alreadyDecided(tx, job))
        return { kind: 'done' as const, outcome: { decision: 'skipped:duplicate' } };

      const loaded = await this.configs.latest(tx);
      const configVersion = loaded.kind === 'missing' ? null : loaded.version;
      const skip = this.filter(snapshot, loaded);
      if (skip) {
        await this.insertRun(tx, job, { configVersion, decision: `skipped:${skip}` });
        return { kind: 'done' as const, outcome: { decision: `skipped:${skip}` } };
      }
      const config = (loaded as Extract<Loaded, { kind: 'ok' }>).config;
      const isOpen = isOpenAt(config.business.service_hours, snapshot.timezone, now);

      // Entrante sin texto (audio, imagen sin epígrafe…): no hay transcripción todavía.
      if (!snapshot.latestInboundHasText) {
        const outcome = await this.handleUnsupportedMedia(tx, job, config, configVersion!, snapshot, isOpen);
        return { kind: 'done' as const, outcome };
      }

      const history = await this.loadHistory(tx, job.conversationId, snapshot.timezone);
      const input: TurnInput = {
        config,
        timezone: snapshot.timezone,
        now,
        history,
        burstTexts: burstTexts(history),
        state: stateOf(snapshot),
      };
      return { kind: 'call' as const, input, configVersion: configVersion! };
    });
    if (first.kind === 'done') return first.outcome;

    // ---- Modelo (fuera de toda transacción) ----
    const { input, configVersion } = first;
    let selection: LlmSelection;
    try {
      selection = await this.llm.forTenant(job.tenantId, input.config);
    } catch {
      return this.recordOnly(job, configVersion, 'error:model_unavailable');
    }
    const prepared = prepareTurn(input, selection.model);
    const reservation = await this.budget.reserve(job.tenantId, prepared.estimateUsd);
    if (!reservation.ok) {
      return this.finish(job, input, prepared, selection, configVersion, {
        kind: 'budget',
        reason: reservation.reason,
      });
    }

    // Visto + "escribiendo…" mientras el modelo piensa: el envío descuenta este tiempo de su demora.
    const typingSince = await this.startTyping(job);

    let call: CallResult;
    try {
      call = { kind: 'ok', result: await selection.client.complete(prepared.request) };
    } catch (error) {
      if (!(error instanceof LlmError)) {
        await this.budget.release(reservation.reservationId);
        if (typingSince) await this.stopTyping(job);
        throw error;
      }
      call = { kind: 'error', error };
    }

    // ---- T2 ----
    let outcome: AiReplyOutcome & { runId?: string };
    try {
      outcome = await this.finish(job, input, prepared, selection, configVersion, call, typingSince);
    } catch (error) {
      // Falló la base en la T2: pg-boss reintenta; mientras, que no quede "escribiendo…".
      if (typingSince) await this.stopTyping(job);
      throw error;
    }
    // Sin mensaje que mandar (none, pausada, error…): que no quede "escribiendo…" colgado.
    if (typingSince && !outcome.sent) await this.stopTyping(job);
    const charged = call.kind === 'ok' ? call.result : call.error.charged;
    if (charged && outcome.runId)
      await this.budget.settle(reservation.reservationId, charged.costUsd, outcome.runId);
    else await this.budget.release(reservation.reservationId);
    return outcome;
  }

  /** T2: re-verifica con la conversación bloqueada, decide y aplica todo en una transacción. */
  private async finish(
    job: AiReplyJob,
    input: TurnInput,
    prepared: PreparedTurn,
    selection: LlmSelection,
    configVersion: number,
    call: CallResult | { kind: 'budget'; reason: string },
    typingSince: Date | null = null,
  ): Promise<AiReplyOutcome & { runId?: string }> {
    return withTenantTransaction(this.database.db, { tenantId: job.tenantId }, async (tx) => {
      const charged =
        call.kind === 'ok' ? call.result : call.kind === 'error' ? call.error.charged : undefined;
      const usage: Partial<NewAiRun> = {
        provider: selection.client.provider,
        model: charged?.model ?? selection.model.id,
        billingMode: selection.billingMode,
        ...(charged
          ? {
              inputTokens: charged.usage.inputTokens,
              outputTokens: charged.usage.outputTokens,
              costUsd: charged.costUsd,
              costSource: charged.costSource,
              latencyMs: charged.latencyMs,
            }
          : {}),
        triggersCode: prepared.triggersCode,
        ...(call.kind === 'ok' ? { output: call.result.parsed, toolCalls: call.result.toolCalls } : {}),
      };
      const base = { configVersion, ...usage };

      const snapshot = await this.lockSnapshot(tx, job.conversationId);
      const loaded = await this.configs.latest(tx);
      const superseded = !snapshot || snapshot.latestInboundId !== job.messageId;
      const skip = snapshot && !superseded ? this.filter(snapshot, loaded) : null;
      if (superseded || skip) {
        // Se registra igual: el modelo ya se llamó (y se cobró).
        const decision = `skipped:${superseded ? 'superseded' : skip}`;
        const runId = snapshot ? await this.insertRun(tx, job, { ...base, decision }) : undefined;
        return { decision, runId, costUsd: charged?.costUsd };
      }

      if (call.kind === 'budget') {
        const evaluation = this.syntheticHandoff(input, snapshot!, call.reason);
        return this.apply(
          tx,
          job,
          input,
          snapshot!,
          prepared.isOpen,
          evaluation,
          { ...base, decision: `skipped:${call.reason}` },
          null,
        );
      }
      if (call.kind === 'error' && call.error.kind !== 'invalid_output' && call.error.kind !== 'truncated') {
        // Error de transporte: se registra sin derivar; el próximo mensaje del cliente vuelve a intentar.
        const decision = `error:${call.error.kind}`;
        const runId = await this.insertRun(tx, job, { ...base, decision });
        return { decision, runId, costUsd: charged?.costUsd };
      }

      const state = stateOf(snapshot!);
      const afterFieldsAsks = await this.countRuns(tx, job.conversationId, 'asked_fields');
      const output = call.kind === 'ok' ? call.result.parsed : null;
      const evaluation = evaluateTurn({ ...input, state }, prepared, output, afterFieldsAsks);
      return this.apply(tx, job, input, snapshot!, prepared.isOpen, evaluation, base, typingSince);
    });
  }

  /** Aplica una evaluación: conversación, envío (respuesta o texto fijo de derivación) y ai_runs. */
  private async apply(
    tx: AppTx,
    job: AiReplyJob,
    input: TurnInput,
    snapshot: Snapshot,
    isOpen: boolean,
    evaluation: TurnEvaluation,
    run: Partial<NewAiRun>,
    typingSince: Date | null,
  ): Promise<AiReplyOutcome & { runId?: string }> {
    const { config } = input;
    const { decision } = evaluation;
    const score = evaluation.score;
    const effectiveScore = score ?? snapshot.leadScore;
    const hot = effectiveScore !== null && effectiveScore >= config.scoring.thresholds.hot;

    await tx.execute(sql`
      UPDATE conversations SET
        lead_score = COALESCE(${score}::smallint, lead_score),
        lead_score_peak = CASE WHEN ${score}::smallint IS NULL THEN lead_score_peak
                               ELSE GREATEST(COALESCE(lead_score_peak, 0), ${score}::smallint) END,
        lead_score_at = CASE WHEN ${score}::smallint IS NULL THEN lead_score_at ELSE now() END,
        score_breakdown = COALESCE(${evaluation.breakdown ? JSON.stringify(evaluation.breakdown) : null}::jsonb, score_breakdown),
        lead_tier = COALESCE(${score === null ? null : tierFor(score, config.scoring.thresholds)}, lead_tier),
        extracted_data = extracted_data || ${JSON.stringify(evaluation.extracted)}::jsonb,
        discovered_notes = ${JSON.stringify(evaluation.discovered)}::jsonb
      WHERE id = ${job.conversationId}
    `);

    let outboundId: string | null = null;
    let decisionName: string;
    if (decision.kind === 'reply') {
      const sent = await this.sendAiReply(tx, job, decision.text, typingSince);
      outboundId = sent.outboundId;
      decisionName = sent.rejected
        ? 'error:send_rejected'
        : decision.source === 'ask_fields'
          ? 'asked_fields'
          : 'replied';
      if (sent.created && !sent.rejected) {
        await tx.execute(sql`
          UPDATE conversations SET
            qualification_turns = qualification_turns + 1,
            hot_turns = hot_turns + ${hot ? 1 : 0},
            suggestions_count = suggestions_count + ${decision.suggestion ? 1 : 0}
          WHERE id = ${job.conversationId}
        `);
      }
    } else if (decision.kind === 'handoff') {
      outboundId = await this.handOff(
        tx,
        job,
        config,
        decision.reason,
        evaluation.handoffSummary!,
        isOpen,
        typingSince,
      );
      decisionName = decision.blocked
        ? `blocked:${decision.blocked}`
        : decision.reason === 'invalid_output'
          ? 'error:invalid_output'
          : 'handed_off';
    } else {
      decisionName = 'none';
    }

    const runId = await this.insertRun(tx, job, {
      ...run,
      decision: run.decision ?? decisionName,
      score,
      scoreBreakdown: evaluation.breakdown,
      triggersModel: evaluation.output?.triggers ?? [],
      handoffReason: decision.kind === 'handoff' ? decision.reason : null,
      outboundMessageId: outboundId,
    });
    this.logger.log({
      msg: 'ai-reply',
      conversationId: job.conversationId,
      messageId: job.messageId,
      decision: run.decision ?? decisionName,
      ...(decision.kind === 'handoff' ? { handoffReason: decision.reason } : {}),
      score,
      triggers: evaluation.triggers,
      costUsd: run.costUsd,
      latencyMs: run.latencyMs,
    });
    return {
      decision: run.decision ?? decisionName,
      runId,
      score,
      costUsd: run.costUsd ?? undefined,
      latencyMs: run.latencyMs ?? undefined,
      sent: outboundId !== null,
    };
  }

  /** La única salida de texto generado: solo acepta un SafeReply (pasó los controles de salida). */
  private async sendAiReply(tx: AppTx, job: AiReplyJob, text: SafeReply, typingSince: Date | null) {
    const result = await this.outbound.enqueueText(
      {
        conversationId: job.conversationId,
        body: text,
        senderType: 'ai',
        idempotencyKey: `ai:${job.messageId}`,
        typingSince,
      },
      tx,
    );
    return { outboundId: result.outboundId, created: result.created, rejected: result.status === 'rejected' };
  }

  /** Deriva: marca la conversación y manda el texto fijo de la empresa, una sola vez por conversación. */
  private async handOff(
    tx: AppTx,
    job: AiReplyJob,
    config: TenantConfig,
    reason: string,
    summary: string,
    isOpen: boolean,
    typingSince: Date | null = null,
  ): Promise<string> {
    await tx.execute(sql`
      UPDATE conversations SET handed_off_at = now(), handoff_reason = ${reason}, handoff_summary = ${summary}
      WHERE id = ${job.conversationId} AND handed_off_at IS NULL
    `);
    const result = await this.outbound.enqueueText(
      {
        conversationId: job.conversationId,
        body: isOpen ? config.handoff.message_in_hours : config.handoff.message_after_hours,
        senderType: 'app',
        idempotencyKey: `handoff:${job.conversationId}`,
        typingSince,
      },
      tx,
    );
    return result.outboundId;
  }

  private async handleUnsupportedMedia(
    tx: AppTx,
    job: AiReplyJob,
    config: TenantConfig,
    configVersion: number,
    snapshot: Snapshot,
    isOpen: boolean,
  ): Promise<AiReplyOutcome> {
    const media = config.handoff.unsupported_media;
    if (media.mode === 'ask_text' && (await this.countRuns(tx, job.conversationId, 'asked_text')) === 0) {
      const sent = await this.outbound.enqueueText(
        {
          conversationId: job.conversationId,
          body: media.message,
          senderType: 'app',
          idempotencyKey: `media-ask:${job.conversationId}`,
        },
        tx,
      );
      await this.insertRun(tx, job, {
        configVersion,
        decision: 'asked_text',
        outboundMessageId: sent.outboundId,
      });
      this.logger.log({ msg: 'ai-reply', conversationId: job.conversationId, decision: 'asked_text' });
      return { decision: 'asked_text' };
    }
    const summary = composeHandoffSummary({
      modelSummary: null,
      reason: 'unsupported_media',
      config,
      extracted: snapshot.extracted,
      discovered: snapshot.discovered,
    });
    const outboundId = await this.handOff(tx, job, config, 'unsupported_media', summary, isOpen);
    await this.insertRun(tx, job, {
      configVersion,
      decision: 'handed_off',
      handoffReason: 'unsupported_media',
      outboundMessageId: outboundId,
    });
    this.logger.log({
      msg: 'ai-reply',
      conversationId: job.conversationId,
      decision: 'handed_off',
      handoffReason: 'unsupported_media',
    });
    return { decision: 'handed_off' };
  }

  /** Sin presupuesto (tarea 008): no se llamó al modelo y se deriva con lo que haya. */
  private syntheticHandoff(input: TurnInput, snapshot: Snapshot, reason: string): TurnEvaluation {
    const decision: Decision = { kind: 'handoff', reason };
    return {
      output: null,
      extracted: snapshot.extracted,
      discovered: snapshot.discovered,
      breakdown: null,
      score: null,
      decision,
      triggers: [],
      handoffSummary: composeHandoffSummary({
        modelSummary: null,
        reason,
        config: input.config,
        extracted: snapshot.extracted,
        discovered: snapshot.discovered,
      }),
    };
  }

  /** Nunca corta la corrida: si la presencia falla, se sigue sin "escribiendo…". */
  private async startTyping(job: AiReplyJob): Promise<Date | null> {
    try {
      return await this.presence.startTyping(job.tenantId, job.conversationId);
    } catch {
      return null;
    }
  }

  private async stopTyping(job: AiReplyJob): Promise<void> {
    try {
      await this.presence.stopTyping(job.tenantId, job.conversationId);
    } catch {
      // Sin efecto: el indicador de WhatsApp vence solo.
    }
  }

  private async recordOnly(
    job: AiReplyJob,
    configVersion: number,
    decision: string,
  ): Promise<AiReplyOutcome> {
    await withTenantTransaction(this.database.db, { tenantId: job.tenantId }, (tx) =>
      this.insertRun(tx, job, { configVersion, decision }),
    );
    return { decision };
  }

  private filter(snapshot: Snapshot, loaded: Loaded): SkipReason | null {
    if (!this.env.AI_ENABLED) return 'ai_disabled';
    // Un trabajo ya encolado de una empresa que se suspendió en el medio.
    if (!snapshot.tenantActive) return 'tenant_suspended';
    if (loaded.kind === 'missing') return 'no_config';
    if (loaded.kind === 'invalid') return 'invalid_config';
    if (!loaded.config.ai.enabled) return 'tenant_disabled';
    if (!loaded.config.ai.channel_ids.includes(snapshot.channelId)) return 'channel_disabled';
    if (snapshot.status !== 'open') return 'conversation_closed';
    if (snapshot.inbox !== 'sales') return 'inbox_other';
    if (snapshot.contactBlocked) return 'contact_blocked';
    if (snapshot.paused) return 'ai_paused';
    if (snapshot.handedOff) return 'handed_off';
    if (snapshot.lastDirection !== 'inbound') return 'last_not_client';
    if (snapshot.pendingOutbound) return 'pending_outbound';
    return null;
  }

  /** Estado de la conversación con la fila bloqueada (FOR UPDATE de conversations). */
  private async lockSnapshot(tx: AppTx, conversationId: string): Promise<Snapshot | null> {
    const result = await tx.execute<{
      status: string;
      inbox: string;
      channel_id: string;
      paused: boolean;
      handed_off: boolean;
      blocked: boolean;
      timezone: string;
      tenant_active: boolean;
      latest_inbound_id: string | null;
      latest_inbound_type: MessageType | null;
      latest_inbound_has_text: boolean | null;
      last_direction: string | null;
      pending_outbound: boolean;
      extracted_data: Record<string, ExtractedValue>;
      discovered_notes: DiscoveredNote[];
      lead_score: number | null;
      lead_score_peak: number | null;
      qualification_turns: number;
      hot_turns: number;
      suggestions_count: number;
    }>(sql`
      SELECT c.status, c.inbox, c.channel_id,
             COALESCE(c.ai_paused_until > now(), false) AS paused,
             c.handed_off_at IS NOT NULL AS handed_off,
             ct.blocked, t.timezone, t.status = 'active' AS tenant_active,
             li.id AS latest_inbound_id, li.type AS latest_inbound_type,
             (li.body IS NOT NULL AND btrim(li.body) <> '') AS latest_inbound_has_text,
             (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id
               ORDER BY m.sent_at DESC, m.created_at DESC LIMIT 1) AS last_direction,
             EXISTS (SELECT 1 FROM outbound_messages o WHERE o.conversation_id = c.id
               AND o.status IN ('queued', 'sending')) AS pending_outbound,
             c.extracted_data, c.discovered_notes, c.lead_score, c.lead_score_peak,
             c.qualification_turns, c.hot_turns, c.suggestions_count
      FROM conversations c
      JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
      JOIN tenants t ON t.id = c.tenant_id
      LEFT JOIN LATERAL (
        SELECT m.id, m.type, m.body FROM messages m
        WHERE m.conversation_id = c.id AND m.direction = 'inbound'
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1
      ) li ON true
      WHERE c.id = ${conversationId}
      FOR UPDATE OF c
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      status: row.status,
      inbox: row.inbox,
      channelId: row.channel_id,
      paused: row.paused,
      handedOff: row.handed_off,
      contactBlocked: row.blocked,
      timezone: row.timezone,
      tenantActive: row.tenant_active,
      latestInboundId: row.latest_inbound_id,
      latestInboundType: row.latest_inbound_type,
      latestInboundHasText: row.latest_inbound_has_text === true,
      lastDirection: row.last_direction,
      pendingOutbound: row.pending_outbound,
      extracted: row.extracted_data ?? {},
      discovered: row.discovered_notes ?? [],
      leadScore: row.lead_score,
      leadScorePeak: row.lead_score_peak,
      qualificationTurns: row.qualification_turns,
      hotTurns: row.hot_turns,
      suggestionsCount: row.suggestions_count,
    };
  }

  private async loadHistory(tx: AppTx, conversationId: string, timezone: string): Promise<HistoryMessage[]> {
    const result = await tx.execute<{
      direction: string;
      sender_type: string;
      type: MessageType;
      body: string | null;
      sent_at: Date | string;
    }>(sql`
      SELECT direction, sender_type, type, body, sent_at FROM messages
      WHERE conversation_id = ${conversationId}
      ORDER BY sent_at DESC, created_at DESC
      LIMIT ${AI_HISTORY_MESSAGES}
    `);
    return result.rows.reverse().map((row) => {
      const local = localTime(new Date(row.sent_at), timezone);
      return {
        author: AUTHORS[row.sender_type] ?? 'sistema',
        type: row.type,
        at: `${local.date} ${local.time}`,
        text: row.body,
      };
    });
  }

  private async alreadyDecided(tx: AppTx, job: AiReplyJob): Promise<boolean> {
    const result = await tx.execute(sql`
      SELECT 1 FROM ai_runs WHERE conversation_id = ${job.conversationId}
        AND trigger_message_id = ${job.messageId} AND ${FINAL_DECISION} LIMIT 1
    `);
    return result.rows.length > 0;
  }

  private async countRuns(tx: AppTx, conversationId: string, decision: string): Promise<number> {
    const result = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM ai_runs WHERE conversation_id = ${conversationId} AND decision = ${decision}
    `);
    return result.rows[0]?.n ?? 0;
  }

  private async insertRun(
    tx: AppTx,
    job: AiReplyJob,
    run: Partial<NewAiRun> & { decision: string },
  ): Promise<string> {
    const [row] = await tx
      .insert(aiRuns)
      .values({
        ...run,
        tenantId: sql`app_tenant_id()`,
        conversationId: job.conversationId,
        triggerMessageId: job.messageId,
        promptVersion: PROMPT_VERSION,
      })
      .returning({ id: aiRuns.id });
    return row!.id;
  }
}

type CallResult = { kind: 'ok'; result: LlmResult<AgentOutput> } | { kind: 'error'; error: LlmError };

function stateOf(snapshot: Snapshot): TenantLayerState {
  return {
    extracted: snapshot.extracted,
    discovered: snapshot.discovered,
    lastScore: snapshot.leadScore,
    counters: {
      qualificationTurns: snapshot.qualificationTurns,
      hotTurns: snapshot.hotTurns,
      suggestionsCount: snapshot.suggestionsCount,
      afterFieldsAsks: 0,
    },
  };
}

/** Textos del cliente posteriores al último mensaje saliente (la ráfaga que se está respondiendo). */
export function burstTexts(history: HistoryMessage[]): string[] {
  const texts: string[] = [];
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.author !== 'cliente') break;
    if (message.text) texts.unshift(message.text);
  }
  return texts;
}
