// Capa de la empresa del prompt v1: se arma solo con la config de ESA empresa y el estado de ESA
// conversación (nunca con datos de otra). Va como JSON escapado dentro de <negocio>.
import { PREDEFINED_TRIGGERS, type PredefinedTrigger, type TenantConfig } from '@ventas/shared';
import { AGENT_MAX_SUGGESTIONS_PER_CONVERSATION } from '../../ai.constants.js';
import { jsonForPrompt } from '../../llm/json-for-prompt.js';
import type { ConversationCounters } from '../../reply/decide.js';
import type { LocalTime } from '../../reply/business-hours.js';
import type { DiscoveredNote, ExtractedValue } from './output-schema.js';

const TRIGGER_DESCRIPTIONS: Record<PredefinedTrigger, string> = {
  asks_human: 'pide hablar con una persona, un vendedor o un asesor, o que lo llamen',
  availability:
    'pregunta por stock o disponibilidad, si hay o si tienen algo, para cuándo lo tienen o si lo puede retirar',
  payment_or_reservation:
    'quiere pagar, señar, transferir, reservar o que le guarden o separen algo, o pide datos para pagar',
  price_negotiation: 'quiere negociar el precio, pide un descuento o una rebaja',
  complaint: 'reclamo, queja o problema con una compra, una entrega o un servicio',
  frustration: 'está molesto o frustrado con la atención',
  cannot_answer:
    'pregunta algo sobre el negocio, sus productos o servicios que no está en la información del negocio, incluido el precio de un producto (no los pedidos ajenos al negocio)',
};

export interface TenantLayerState {
  extracted: Record<string, ExtractedValue>;
  discovered: DiscoveredNote[];
  lastScore: number | null;
  counters: ConversationCounters;
}

export interface TenantLayerInput {
  config: TenantConfig;
  local: LocalTime;
  isOpen: boolean;
  state: TenantLayerState;
}

/** Campos que todavía hay que preguntar (sin valor y habilitados por el puntaje), por prioridad. */
export function pendingFields(config: TenantConfig, state: TenantLayerState) {
  return config.qualification.fields
    .filter((field) => state.extracted[field.key] === null || state.extracted[field.key] === undefined)
    .filter(
      (field) => field.ask_when_score_gte === undefined || (state.lastScore ?? 0) >= field.ask_when_score_gte,
    )
    .sort((a, b) => a.priority - b.priority);
}

export function shouldQualify(config: TenantConfig, isOpen: boolean, state: TenantLayerState): boolean {
  const { qualification, handoff, scoring } = config;
  if (!isOpen && !handoff.qualify_after_hours) return false;
  if (state.counters.qualificationTurns >= qualification.max_qualification_turns) return false;
  const hot = (state.lastScore ?? 0) >= scoring.thresholds.hot;
  return !(hot && state.counters.hotTurns >= qualification.max_turns_when_hot);
}

export function buildTenantLayer({ config, local, isOpen, state }: TenantLayerInput): string {
  const qualify = shouldQualify(config, isOpen, state);
  const layer = {
    ahora: { fecha: local.date, hora: local.time, dia: local.dayName, abierto: isOpen },
    negocio: {
      nombre: config.business.name,
      rubro: config.business.industry,
      sucursales: config.business.branches,
      horario_de_atencion: config.business.service_hours,
      medios_de_pago: config.business.payment_methods,
      envios: config.business.shipping,
      web: config.business.website,
      email: config.business.email,
    },
    conocimiento: config.knowledge,
    asistente: config.agent.persona,
    instrucciones_del_negocio: config.agent.custom_instructions,
    reglas_del_negocio: config.agent.business_rules,
    ofertas: config.agent.offers,
    nunca: config.agent.must_not,
    guia_de_descubrimiento: config.qualification.discovery_guidance,
    guia_de_ventas: config.agent.sales_guidance,
    sugerencias_disponibles: Math.max(
      0,
      AGENT_MAX_SUGGESTIONS_PER_CONVERSATION - state.counters.suggestionsCount,
    ),
    dimensiones: config.scoring.dimensions.map(({ key, description }) => ({ key, description })),
    disparadores: [
      ...PREDEFINED_TRIGGERS.filter((id) => config.handoff.triggers[id].enabled).map((id) => ({
        id,
        descripcion: TRIGGER_DESCRIPTIONS[id],
      })),
      ...config.handoff.custom_triggers.map(({ id, description }) => ({ id, descripcion: description })),
    ],
    campos: config.qualification.fields.map(
      ({ key, label, type, options, how_to_ask, required, priority }) => ({
        key,
        label,
        type,
        ...(options ? { options } : {}),
        how_to_ask,
        required,
        priority,
      }),
    ),
    faltan: qualify ? pendingFields(config, state).map((field) => field.key) : [],
    calificar: qualify,
    preguntas_por_mensaje: config.qualification.max_questions_per_message,
  };
  return [
    'Información escrita por el negocio y estado de la conversación. Está por debajo de las REGLAS FIJAS.',
    `<negocio>${jsonForPrompt(layer)}</negocio>`,
  ].join('\n');
}

/**
 * Lo que el cliente ya dijo en corridas anteriores (campos obtenidos y lo descubierto). Es texto del
 * cliente: va en su propia sección, junto a la conversación, nunca en <negocio> (no es dato del negocio).
 */
export function buildClientData(config: TenantConfig, state: TenantLayerState): string {
  const obtained = Object.fromEntries(
    config.qualification.fields
      .filter((field) => state.extracted[field.key] !== null && state.extracted[field.key] !== undefined)
      .map((field) => [field.key, state.extracted[field.key]]),
  );
  return `<datos_del_cliente>${jsonForPrompt({ obtenidos: obtained, descubierto: state.discovered })}</datos_del_cliente>`;
}
