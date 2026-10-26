// Decisión de cada corrida (tarea 006), en código y sin acceso a la base: lo que diga el modelo es una
// señal, no una orden. El orden de las ramas es el de la tarea; un reply nunca sale si corresponde derivar
// (las ramas de derivación van todas antes que la del reply).
import { PREDEFINED_TRIGGERS, type HandoffMode, type TenantConfig } from '@ventas/shared';
import { AFTER_FIELDS_MAX_ASKS, AGENT_MAX_SUGGESTIONS_PER_CONVERSATION } from '../ai.constants.js';
import type { AgentOutput } from '../prompts/v1/output-schema.js';
import { checkReply, type CheckContext, type OutputControl, type SafeReply } from './output-checks.js';

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
  | { kind: 'reply'; text: SafeReply; source: 'model' | 'ask_fields'; suggestion: boolean }
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

/** Preguntas de los campos que faltan para un disparador after_fields, en el idioma del cliente. */
function askFieldsText(
  config: TenantConfig,
  missing: string[],
  intro: string,
  language: string,
): string | null {
  const fields = config.qualification.fields
    .filter((field) => missing.includes(field.key))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, config.qualification.max_questions_per_message);
  const questions: string[] = [];
  for (const field of fields) {
    const question =
      language === config.business.language ? field.how_to_ask : field.how_to_ask_i18n?.[language];
    if (!question) return null;
    questions.push(question);
  }
  return [intro, ...questions].join(' ');
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

  const immediate = triggers.find((id) => modeOf(config, id)!.type === 'immediate');
  if (immediate) return { decision: handoff(immediate), triggers };

  const afterFields = triggers.filter((id) => modeOf(config, id)!.type === 'after_fields');
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
    const text = intro ? askFieldsText(config, missing, intro, output.language) : null;
    if (!text) return { decision: handoff(`${first}:idioma`), triggers };
    const checked = checkReply(text, input.checks);
    if (!checked.ok) return { decision: handoff(`blocked:${checked.control}`, checked.control), triggers };
    return {
      decision: { kind: 'reply', text: checked.reply, source: 'ask_fields', suggestion: false },
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
  if (output.action === 'reply' && output.reply !== null) {
    const suggestion = output.suggestion !== null;
    if (suggestion && counters.suggestionsCount >= AGENT_MAX_SUGGESTIONS_PER_CONVERSATION) {
      return { decision: handoff('blocked:suggestion_limit', 'suggestion_limit'), triggers };
    }
    const checked = checkReply(output.reply, input.checks);
    if (!checked.ok) return { decision: handoff(`blocked:${checked.control}`, checked.control), triggers };
    return { decision: { kind: 'reply', text: checked.reply, source: 'model', suggestion }, triggers };
  }

  // 8. Nada.
  return { decision: { kind: 'none' }, triggers };
}
