// Playground del panel (tarea 027): un turno del agente con la configuración EN EDICIÓN (sin guardar), con el
// mismo reply-engine que el worker (prepareTurn → modelo → evaluateTurn: prompt, schema, decide() y controles
// de salida) y las herramientas del catálogo de la empresa en solo lectura.
// - No envía nada (ni OutboundService ni PresenceService), no crea conversaciones ni mensajes y no escribe en
//   ai_runs ni en product_snapshots: la conversación de prueba vive en el panel, que manda el historial y el
//   estado en cada turno (decisión #114).
// - Solo registra el costo y la decisión en ai_playground_runs, sin texto.
// - Límites: 20 mensajes por prueba, 30 turnos por hora por empresa, AI_ENABLED y el AiBudgetGuard.
// - Corre fuera de la transacción del request (@NoTransaction): el modelo tarda segundos.
// Logs: solo ids, decisión y costo, nunca los mensajes de prueba ni la config.
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { tierFor, type TenantConfig } from '@ventas/shared';
import { sql } from 'drizzle-orm';
import { CatalogService } from '../../catalog/catalog.service.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { APP_DB, type AppDatabase } from '../../db/database.module.js';
import { aiPlaygroundRuns } from '../../db/schema/ai.js';
import { withTenantTransaction, type TenantContext } from '../../db/tenant-context.js';
import { AI_BUDGET_GUARD, type AiBudgetGuard } from '../llm/budget-guard.js';
import { LLM_CLIENT_FACTORY, type LlmClientFactory, type LlmSelection } from '../llm/llm-client.factory.js';
import { LlmError, type LlmResult } from '../llm/llm-client.js';
import { PROMPT_VERSION, type HistoryMessage } from '../prompts/v2/index.js';
import type { AgentOutput } from '../prompts/v2/output-schema.js';
import { burstTexts } from '../reply/ai-reply.service.js';
import { localTime } from '../reply/business-hours.js';
import { evaluateTurn, prepareTurn, type TurnInput } from '../reply/reply-engine.js';
import {
  PLAYGROUND_TURNS_PER_HOUR,
  type PlaygroundBody,
  type PlaygroundState,
} from './agent-config.contracts.js';
import { AgentConfigService } from './agent-config.service.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const MINUTE_MS = 60_000;

/**
 * El próximo momento (desde ahora) que en la zona de la empresa es ese día de la semana y esa hora. Se
 * corrige una vez por si en el medio hay un cambio de horario.
 */
export function simulatedNow(now: Date, timezone: string, day: (typeof DAYS)[number], time: string): Date {
  const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const target = DAYS.indexOf(day) * 1440 + minutesOf(time);
  const at = (candidate: Date) => {
    const local = localTime(candidate, timezone);
    return DAYS.indexOf(local.day) * 1440 + minutesOf(local.time);
  };
  let delta = (target - at(now) + 7 * 1440) % (7 * 1440);
  let candidate = new Date(now.getTime() + delta * MINUTE_MS);
  delta = (target - at(candidate) + 7 * 1440) % (7 * 1440);
  if (delta !== 0)
    candidate = new Date(candidate.getTime() + (delta > 3.5 * 1440 ? delta - 7 * 1440 : delta) * MINUTE_MS);
  return candidate;
}

@Injectable()
export class PlaygroundService {
  private readonly logger = new Logger('Playground');
  /**
   * Turnos en curso por empresa (todavía sin fila en ai_playground_runs). En memoria: con varias instancias,
   * cada una suma los suyos (deuda de la 027, como los otros límites en memoria).
   */
  private readonly inFlight = new Map<string, number>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_DB) private readonly database: AppDatabase,
    @Inject(LLM_CLIENT_FACTORY) private readonly llm: LlmClientFactory,
    @Inject(AI_BUDGET_GUARD) private readonly budget: AiBudgetGuard,
    private readonly catalog: CatalogService,
    private readonly agentConfig: AgentConfigService,
  ) {}

  async turn(context: TenantContext, body: PlaygroundBody) {
    if (!this.env.AI_ENABLED) throw new ServiceUnavailableException({ code: 'AI_DISABLED' });
    const config = this.agentConfig.validated(body.config);
    // Después de derivar el agente no vuelve a escribir: hay que empezar de nuevo.
    if (body.state.handedOff) throw new ConflictException({ code: 'HANDED_OFF' });

    const ids = { tenantId: context.tenantId, userId: context.userId };
    const { timezone, turnsLastHour } = await withTenantTransaction(this.database.db, ids, async (tx) => {
      // Lock por empresa + los turnos en curso (todavía sin fila): pedidos en paralelo no pasan todos con el
      // mismo lugar libre. El lugar se reserva antes de soltar el lock y se libera al terminar el turno.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('playground:' || app_tenant_id()::text, 0))`,
      );
      const counted = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM ai_playground_runs WHERE created_at > now() - interval '1 hour'
      `);
      const used = counted.rows[0]!.n + (this.inFlight.get(context.tenantId) ?? 0);
      if (used >= PLAYGROUND_TURNS_PER_HOUR) {
        throw new HttpException({ code: 'PLAYGROUND_LIMIT' }, HttpStatus.TOO_MANY_REQUESTS);
      }
      this.inFlight.set(context.tenantId, (this.inFlight.get(context.tenantId) ?? 0) + 1);
      const tenant = await tx.execute<{ timezone: string }>(
        sql`SELECT timezone FROM tenants WHERE id = app_tenant_id()`,
      );
      return { timezone: tenant.rows[0]!.timezone, turnsLastHour: used };
    });
    try {
      return await this.run(context, body, config, timezone, turnsLastHour);
    } finally {
      const left = (this.inFlight.get(context.tenantId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(context.tenantId, left);
      else this.inFlight.delete(context.tenantId);
    }
  }

  private async run(
    context: TenantContext,
    body: PlaygroundBody,
    config: TenantConfig,
    timezone: string,
    turnsLastHour: number,
  ) {
    const ids = { tenantId: context.tenantId, userId: context.userId };

    const now = body.simulate
      ? simulatedNow(new Date(), timezone, body.simulate.day, body.simulate.time)
      : new Date();
    const local = localTime(now, timezone);
    const history: HistoryMessage[] = body.history.map((message) => ({
      author: message.author,
      type: 'text',
      at: `${local.date} ${local.time}`,
      text: message.text,
    }));
    const input: TurnInput = {
      config,
      timezone,
      now,
      history,
      burstTexts: burstTexts(history),
      state: {
        extracted: body.state.extracted,
        discovered: body.state.discovered,
        lastScore: body.state.lastScore,
        counters: body.state.counters,
      },
    };

    const turnCatalog = this.catalog.forTurn(context.tenantId, config.catalog, now, timezone, {
      readOnly: true,
    });
    let selection: LlmSelection;
    try {
      selection = await this.llm.forTenant(context.tenantId, config, { catalogTurn: turnCatalog !== null });
    } catch {
      throw new ServiceUnavailableException({ code: 'MODEL_UNAVAILABLE' });
    }
    const prepared = prepareTurn(
      input,
      selection.model,
      turnCatalog
        ? { ...turnCatalog, toolOutputMode: selection.toolOutputMode ?? 'response_format' }
        : undefined,
    );
    const reservation = await this.budget.reserve(context.tenantId, prepared.estimateUsd);
    if (!reservation.ok) throw new ConflictException({ code: 'BUDGET', reason: reservation.reason });

    let result: LlmResult<AgentOutput> | null = null;
    let failure: LlmError | null = null;
    try {
      result = await selection.client.complete(prepared.request);
    } catch (error) {
      if (!(error instanceof LlmError)) {
        await this.budget.release(reservation.reservationId);
        throw error;
      }
      failure = error;
    }
    const charged = result ?? failure?.charged ?? null;

    // Error de transporte: no hay decisión (el worker tampoco responde); salida inválida o cortada: decide()
    // deriva por invalid_output, como en producción.
    const transport = failure && failure.kind !== 'invalid_output' && failure.kind !== 'truncated';
    const evaluation = transport
      ? null
      : evaluateTurn(input, prepared, result?.parsed ?? null, body.state.counters.afterFieldsAsks);
    const decision = evaluation?.decision ?? null;
    const decisionName = !decision
      ? `error:${failure!.kind}`
      : decision.kind === 'reply'
        ? decision.source === 'ask_fields'
          ? 'asked_fields'
          : 'replied'
        : decision.kind === 'handoff'
          ? decision.blocked
            ? `blocked:${decision.blocked}`
            : decision.reason === 'invalid_output'
              ? 'error:invalid_output'
              : 'handed_off'
          : 'none';

    const runId = await withTenantTransaction(this.database.db, ids, async (tx) => {
      const [run] = await tx
        .insert(aiPlaygroundRuns)
        .values({
          tenantId: sql`app_tenant_id()`,
          userId: context.userId,
          baseConfigVersion: body.baseVersion,
          promptVersion: PROMPT_VERSION,
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
          decision: decisionName,
        })
        .returning({ id: aiPlaygroundRuns.id });
      return run!.id;
    });
    if (charged) await this.budget.settle(reservation.reservationId, charged.costUsd, runId);
    else await this.budget.release(reservation.reservationId);
    this.logger.log({
      msg: 'playground',
      tenantId: context.tenantId,
      runId,
      decision: decisionName,
      costUsd: charged?.costUsd ?? null,
    });

    const hot = (evaluation?.score ?? body.state.lastScore ?? -1) >= config.scoring.thresholds.hot;
    const reply =
      decision?.kind === 'reply'
        ? String(decision.text)
        : decision?.kind === 'handoff'
          ? prepared.isOpen
            ? config.handoff.message_in_hours
            : config.handoff.message_after_hours
          : null;
    const state: PlaygroundState = evaluation
      ? {
          extracted: evaluation.extracted,
          discovered: evaluation.discovered,
          lastScore: evaluation.score ?? body.state.lastScore,
          counters: {
            qualificationTurns: body.state.counters.qualificationTurns + (decision?.kind === 'reply' ? 1 : 0),
            hotTurns: body.state.counters.hotTurns + (decision?.kind === 'reply' && hot ? 1 : 0),
            suggestionsCount:
              body.state.counters.suggestionsCount +
              (decision?.kind === 'reply' && decision.suggestion ? 1 : 0),
            afterFieldsAsks:
              body.state.counters.afterFieldsAsks +
              (decision?.kind === 'reply' && decision.source === 'ask_fields' ? 1 : 0),
          },
          handedOff: decision?.kind === 'handoff',
        }
      : body.state;

    return {
      reply,
      decision: decisionName,
      detail: {
        isOpen: prepared.isOpen,
        localTime: `${local.dayName} ${local.time}`,
        score: evaluation?.score ?? null,
        tier: evaluation?.score != null ? tierFor(evaluation.score, config.scoring.thresholds) : null,
        breakdown: evaluation?.breakdown
          ? {
              dimensions: Object.entries(evaluation.breakdown.dimensions).map(([key, value]) => ({
                key,
                ...value,
              })),
              completeness: evaluation.breakdown.completeness,
            }
          : null,
        extracted: this.extractedList(config, evaluation?.extracted ?? body.state.extracted),
        triggers: evaluation?.triggers ?? [],
        handoffReason: decision?.kind === 'handoff' ? decision.reason : null,
        handoffSummary: evaluation?.handoffSummary ?? null,
        blocked: decision?.kind === 'handoff' ? (decision.blocked ?? null) : null,
        catalog: prepared.catalog?.used
          ? {
              consulted: prepared.catalog.consulted.map((item) => `${item.tool}:${item.sku}`),
              cited: prepared.catalog.cited.map((item) => `${item.kind}:${item.sku}`),
            }
          : null,
        model: charged?.model ?? selection.model.id,
        costUsd: charged?.costUsd ?? null,
      },
      state,
      turnsLastHour: turnsLastHour + 1,
      turnsPerHour: PLAYGROUND_TURNS_PER_HOUR,
    };
  }

  private extractedList(config: TenantConfig, extracted: PlaygroundState['extracted']) {
    return config.qualification.fields
      .filter((field) => extracted[field.key] !== undefined && extracted[field.key] !== null)
      .map((field) => ({ key: field.key, label: field.label, value: extracted[field.key]! }));
  }
}
