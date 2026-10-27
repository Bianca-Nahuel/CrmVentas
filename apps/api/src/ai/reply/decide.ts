// Decisión de cada corrida (tarea 006), en código y sin acceso a la base: lo que diga el modelo es una
// señal, no una orden. El orden de las ramas es el de la tarea; un reply nunca sale si corresponde derivar
// (las ramas de derivación van todas antes que la del reply).
// v3 (tarea 010): la respuesta puede ir en 1 o 2 mensajes, una pregunta por turno y nunca de un dato que
// ya está (si el modelo la hace igual, el código la saca).
import { PREDEFINED_TRIGGERS, type HandoffMode, type TenantConfig } from '@ventas/shared';
import {
  AFTER_FIELDS_MAX_ASKS,
  AGENT_MAX_SUGGESTIONS_PER_CONVERSATION,
  AI_MAX_QUESTIONS_PER_TURN,
} from '../ai.constants.js';
import type { AgentOutput } from '../prompts/v3/output-schema.js';
import { answersAvailability } from './markers.js';
import { checkReplies, type CheckContext, type OutputControl, type SafeReply } from './output-checks.js';

export interface ConversationCounters {
  qualificationTurns: number;
  hotTurns: number;
  suggestionsCount: number;
  /** Preguntas ya hechas por un disparador after_fields en esta conversación. */
  afterFieldsAsks: number;
}

export interface DecideInput {
  /** null = la salida del modelo no validó. */
  output: AgentOutput | null;
  config: TenantConfig;
  score: number;
  /** Campos con valor (lo anterior combinado con lo de esta corrida). */
  obtained: ReadonlySet<string>;
  triggersCode: string[];
  counters: ConversationCounters;
  isOpen: boolean;
  checks: CheckContext;
}

export type Decision =
  | { kind: 'handoff'; reason: string; blocked?: OutputControl | 'suggestion_limit' }
  | {
      kind: 'reply';
      /** Mensajes a enviar, en orden (1 o 2). */
      parts: SafeReply[];
      source: 'model' | 'ask_fields';
      suggestion: boolean;
      /** El modelo volvió a preguntar un dato que ya estaba y el código sacó esa pregunta. */
      repeatRemoved?: true;
    }
  | { kind: 'none' };

export interface DecideResult {
  decision: Decision;
  /** Disparadores detectados y habilitados (modelo ∪ código). */
  triggers: string[];
}

function modeOf(config: TenantConfig, id: string): HandoffMode | null {
  if ((PREDEFINED_TRIGGERS as readonly string[]).includes(id)) {
    const trigger = config.handoff.triggers[id as (typeof PREDEFINED_TRIGGERS)[number]];
    return trigger.enabled ? trigger.mode : null;
  }
  return config.handoff.custom_triggers.find((trigger) => trigger.id === id)?.mode ?? null;
}

function howToAsk(config: TenantConfig, key: string, language: string): string | null {
  const field = config.qualification.fields.find((candidate) => candidate.key === key);
  if (!field) return null;
  return (
    (language === config.business.language ? field.how_to_ask : field.how_to_ask_i18n?.[language]) ?? null
  );
}

/**
 * Pregunta de los campos que faltan para un disparador after_fields, en el idioma del cliente: una por
 * turno y con el intro de la empresa solo la primera vez (después suena a formulario).
 */
function askFieldsText(
  config: TenantConfig,
  missing: string[],
  intro: string | null,
  language: string,
): string | null {
  const fields = config.qualification.fields
    .filter((field) => missing.includes(field.key))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, Math.min(config.qualification.max_questions_per_message, AI_MAX_QUESTIONS_PER_TURN));
  const questions: string[] = [];
  for (const field of fields) {
    const question = howToAsk(config, field.key, language);
    if (!question) return null;
    questions.push(question);
  }
  return [...(intro ? [intro] : []), ...questions].join(' ');
}

// Una oración termina en "?" (con o sin "¿" al principio): es una pregunta.
const SENTENCE = /[^.!?\n]+(?:[.!?]+|$)/g;

/** Saca las oraciones que preguntan (terminan en "?"); quedan las partes que tienen algo más. */
export function withoutQuestions(parts: string[]): string[] {
  return parts
    .map((part) =>
      (part.match(SENTENCE) ?? [])
        .filter((sentence) => !sentence.trim().endsWith('?'))
        .join('')
        .trim(),
    )
    .filter((part) => part !== '');
}

/** El siguiente dato que conviene preguntar si se sacó una repregunta y no quedó nada para decir. */
function nextFieldQuestion(input: DecideInput, language: string): string | null {
  const { config, obtained, score, counters } = input;
  if (counters.qualificationTurns >= config.qualification.max_qualification_turns) return null;
  const next = config.qualification.fields
    .filter((field) => !obtained.has(field.key))
    .filter((field) => field.ask_when_score_gte === undefined || score >= field.ask_when_score_gte)
    .sort((a, b) => a.priority - b.priority)[0];
  return next ? howToAsk(config, next.key, language) : null;
}

export function decide(input: DecideInput): DecideResult {
  const { output, config, score, obtained, counters } = input;
  const { hot, warm } = config.scoring.thresholds;
  const handoff = (reason: string, blocked?: OutputControl | 'suggestion_limit'): Decision => ({
    kind: 'handoff',
    reason,
    ...(blocked ? { blocked } : {}),
  });

  // 1. Disparadores (modelo ∪ código), solo los habilitados, en orden estable.
  const candidates = [...new Set([...(output?.triggers ?? []), ...input.triggersCode])];
  const triggers = candidates.filter((id) => modeOf(config, id) !== null);

  // 0. Salida inválida: deriva (con lo que haya). Los disparadores del código igual quedan registrados.
  if (!output) return { decision: handoff('invalid_output'), triggers };

  // Catálogo (tarea 007): una pregunta por disponibilidad que la respuesta contesta con una marca de stock
  // válida (la fuente configurada la informa y está vigente) no deriva. Queda registrada igual.
  const active = answersAvailability(output.replies.join('\n'), input.checks.catalog)
    ? triggers.filter((id) => id !== 'availability')
    : triggers;

  const immediate = active.find((id) => modeOf(config, id)!.type === 'immediate');
  if (immediate) return { decision: handoff(immediate), triggers };

  const afterFields = active.filter((id) => modeOf(config, id)!.type === 'after_fields');
  if (afterFields.length > 0) {
    const first = afterFields[0]!;
    const missing = [
      ...new Set(
        afterFields.flatMap(
          (id) => (modeOf(config, id) as Extract<HandoffMode, { type: 'after_fields' }>).fields,
        ),
      ),
    ].filter((key) => !obtained.has(key));
    if (missing.length === 0) return { decision: handoff(first), triggers };
    // Con el lead caliente y los turnos calientes agotados, deriva aunque falten datos (como la rama 3).
    if (score >= hot && counters.hotTurns >= config.qualification.max_turns_when_hot) {
      return { decision: handoff('hot_turns'), triggers };
    }
    if (
      counters.afterFieldsAsks >= AFTER_FIELDS_MAX_ASKS ||
      counters.qualificationTurns >= config.qualification.max_qualification_turns
    ) {
      return { decision: handoff(`${first}:incompleto`), triggers };
    }
    const mode = modeOf(config, first) as Extract<HandoffMode, { type: 'after_fields' }>;
    const intro = mode.intro[output.language];
    const text = intro
      ? askFieldsText(config, missing, counters.afterFieldsAsks === 0 ? intro : null, output.language)
      : null;
    if (!text) return { decision: handoff(`${first}:idioma`), triggers };
    const checked = checkReplies([text], input.checks);
    if (!checked.ok) return { decision: handoff(`blocked:${checked.control}`, checked.control), triggers };
    return {
      decision: { kind: 'reply', parts: checked.parts, source: 'ask_fields', suggestion: false },
      triggers,
    };
  }

  // 2-4. Puntaje caliente.
  const missingRequired = config.qualification.fields.filter(
    (field) => field.required && !obtained.has(field.key),
  );
  if (score >= hot && missingRequired.length === 0) return { decision: handoff('qualified'), triggers };
  if (score >= hot && counters.hotTurns >= config.qualification.max_turns_when_hot) {
    return { decision: handoff('hot_turns'), triggers };
  }
  if (score >= hot && counters.qualificationTurns >= config.qualification.max_qualification_turns) {
    return { decision: handoff('max_turns'), triggers };
  }

  // 5. Fuera de horario sin calificación: un interesado pasa directo a una persona.
  if (!input.isOpen && !config.handoff.qualify_after_hours && score >= warm) {
    return { decision: handoff('after_hours'), triggers };
  }

  // 6. El modelo pide derivar.
  if (output.action === 'handoff') return { decision: handoff('model'), triggers };

  // 7. Respuesta del modelo, solo si pasa los controles.
  if (output.action === 'reply' && output.replies.length > 0) {
    const suggestion = output.suggestion !== null;
    if (suggestion && counters.suggestionsCount >= AGENT_MAX_SUGGESTIONS_PER_CONVERSATION) {
      return { decision: handoff('blocked:suggestion_limit', 'suggestion_limit'), triggers };
    }
    // Nunca se repregunta un dato que ya está (también lo dicho en este turno): se saca la pregunta y, si
    // no queda nada, va la del siguiente dato pendiente; si no hay ninguno, no se responde.
    let parts = output.replies;
    const repeat = output.asks_field !== null && obtained.has(output.asks_field);
    if (repeat) {
      parts = withoutQuestions(parts);
      if (parts.length === 0) {
        const next = nextFieldQuestion(input, output.language);
        if (!next) return { decision: { kind: 'none' }, triggers };
        parts = [next];
      }
    }
    const checked = checkReplies(parts, input.checks);
    if (!checked.ok) return { decision: handoff(`blocked:${checked.control}`, checked.control), triggers };
    return {
      decision: {
        kind: 'reply',
        parts: checked.parts,
        source: 'model',
        suggestion,
        ...(repeat ? { repeatRemoved: true as const } : {}),
      },
      triggers,
    };
  }

  // 8. Nada.
  return { decision: { kind: 'none' }, triggers };
}
