// Un turno del agente sin base de datos ni envío: armar el pedido al modelo (prepareTurn) y, con lo que
// devolvió, combinar datos, puntuar y decidir (evaluateTurn). Lo usan el worker y el runner de evals, así
// los evals prueban el mismo prompt, schema, decisión y controles que producción.
import { normalizeText, type AllowedModel, type CriticalTrigger, type TenantConfig } from '@ventas/shared';
import { AI_MAX_OUTPUT_TOKENS, DISCOVERED_NOTES_MAX } from '../ai.constants.js';
import type { LlmRequest } from '../llm/llm-client.js';
import { addUsd, tokensCostUsd } from '../llm/money.js';
import { buildPrompt, type HistoryMessage } from '../prompts/v1/index.js';
import {
  buildOutputSchema,
  type AgentOutput,
  type DiscoveredNote,
  type ExtractedValue,
} from '../prompts/v1/output-schema.js';
import type { TenantLayerState } from '../prompts/v1/tenant-layer.js';
import { computeScore, type ScoreBreakdown } from '../scoring/score.js';
import { isOpenAt, localTime } from './business-hours.js';
import { detectCriticalTriggers } from './critical-triggers.js';
import { decide, type Decision } from './decide.js';
import { composeHandoffSummary } from './handoff-summary.js';
import { buildCheckContext } from './output-checks.js';

export interface TurnInput {
  config: TenantConfig;
  timezone: string;
  now: Date;
  history: HistoryMessage[];
  /** Textos del cliente posteriores al último saliente (para el detector de disparadores). */
  burstTexts: string[];
  state: TenantLayerState;
}

export interface PreparedTurn {
  request: LlmRequest<AgentOutput>;
  triggersCode: CriticalTrigger[];
  isOpen: boolean;
  /** Estimación previa para el AiBudgetGuard (USD). */
  estimateUsd: string;
}

export interface TurnEvaluation {
  /** null si la salida del modelo no validó. */
  output: AgentOutput | null;
  extracted: Record<string, ExtractedValue>;
  discovered: DiscoveredNote[];
  /** null si la salida no validó (se conserva el puntaje anterior). */
  breakdown: ScoreBreakdown | null;
  score: number | null;
  decision: Decision;
  triggers: string[];
  /** Resumen para el operador, solo si se deriva. */
  handoffSummary: string | null;
}

export function prepareTurn(input: TurnInput, model: AllowedModel): PreparedTurn {
  const local = localTime(input.now, input.timezone);
  const isOpen = isOpenAt(input.config.business.service_hours, input.timezone, input.now);
  const prompt = buildPrompt({
    config: input.config,
    local,
    isOpen,
    state: input.state,
    history: input.history,
  });
  const request: LlmRequest<AgentOutput> = {
    model: model.id,
    system: prompt.system,
    messages: prompt.messages,
    schema: buildOutputSchema(input.config),
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
  };
  // Tokens de entrada aproximados: un token cada ~3 caracteres (alcanza para reservar).
  const chars =
    prompt.system.length + prompt.messages.reduce((total, message) => total + message.content.length, 0);
  const estimateUsd = addUsd(
    tokensCostUsd(Math.ceil(chars / 3), model.inputUsdPerMTok),
    tokensCostUsd(AI_MAX_OUTPUT_TOKENS, model.outputUsdPerMTok),
  );
  return {
    request,
    triggersCode: detectCriticalTriggers(input.burstTexts, input.config),
    isOpen,
    estimateUsd,
  };
}

/** Lo nuevo con valor pisa lo anterior; un null nunca borra un dato que ya estaba. */
export function mergeExtracted(
  config: TenantConfig,
  previous: Record<string, ExtractedValue>,
  next: Record<string, ExtractedValue>,
): Record<string, ExtractedValue> {
  const merged: Record<string, ExtractedValue> = {};
  for (const field of config.qualification.fields) {
    const value = next[field.key] ?? previous[field.key] ?? null;
    if (value !== null) merged[field.key] = value;
  }
  return merged;
}

/** Por tema (normalizado): el valor nuevo reemplaza al anterior. Se conservan los más recientes. */
export function mergeDiscovered(previous: DiscoveredNote[], next: DiscoveredNote[]): DiscoveredNote[] {
  const byTopic = new Map<string, DiscoveredNote>();
  for (const note of [...previous, ...next]) {
    const topic = normalizeText(note.topic);
    byTopic.delete(topic);
    byTopic.set(topic, note);
  }
  return [...byTopic.values()].slice(-DISCOVERED_NOTES_MAX);
}

export function evaluateTurn(
  input: TurnInput,
  prepared: PreparedTurn,
  output: AgentOutput | null,
  afterFieldsAsks: number,
): TurnEvaluation {
  const { config, state } = input;
  const extracted = output
    ? mergeExtracted(config, state.extracted, output.extracted)
    : { ...state.extracted };
  const discovered = output ? mergeDiscovered(state.discovered, output.discovered) : state.discovered;
  const obtained = new Set(Object.keys(extracted));
  const breakdown = output ? computeScore(config, output.signals, obtained) : null;
  const score = breakdown?.score ?? null;

  const { decision, triggers } = decide({
    output,
    config,
    score: score ?? state.lastScore ?? 0,
    obtained,
    triggersCode: prepared.triggersCode,
    counters: { ...state.counters, afterFieldsAsks },
    isOpen: prepared.isOpen,
    checks: buildCheckContext(config),
  });

  const handoffSummary =
    decision.kind === 'handoff'
      ? composeHandoffSummary({
          modelSummary: output?.handoff_summary ?? null,
          reason: decision.reason,
          config,
          extracted,
          discovered,
        })
      : null;

  return { output, extracted, discovered, breakdown, score, decision, triggers, handoffSummary };
}
