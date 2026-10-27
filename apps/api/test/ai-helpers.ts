// Utilidades de los tests del agente (tarea 006): config de prueba, modelo falso y datos de conversación.
// Todo inventado; números ficticios.
import {
  ALLOWED_MODELS,
  tenantConfigSchema,
  type TenantConfig,
  type TenantConfigInput,
} from '@ventas/shared';
import type { LlmClientFactory, LlmSelection } from '../src/ai/llm/llm-client.factory.js';
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from '../src/ai/llm/llm-client.js';
import type { AgentOutput } from '../src/ai/prompts/v3/output-schema.js';
import { withTenant, type TestContext } from './helpers.js';
import { uid } from './outbound-helpers.js';

const ALWAYS_OPEN = [{ open: '00:00', close: '23:59' }];
export const OPEN_WEEK = {
  mon: ALWAYS_OPEN,
  tue: ALWAYS_OPEN,
  wed: ALWAYS_OPEN,
  thu: ALWAYS_OPEN,
  fri: ALWAYS_OPEN,
  sat: ALWAYS_OPEN,
  sun: ALWAYS_OPEN,
};
export const CLOSED_WEEK = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

export const MSG_IN_HOURS = 'Gracias, ya le paso tu consulta a una persona del equipo.';
export const MSG_AFTER_HOURS = 'Gracias, una persona del equipo te va a responder cuando abramos.';
export const MEDIA_ASK = '¿Me lo podés escribir? Todavía no puedo escuchar audios ni ver imágenes.';
export const AVAILABILITY_INTRO = 'Para consultarlo con el equipo necesito un par de datos.';

const immediate = { enabled: true, mode: { type: 'immediate' as const } };

/** Config de prueba parecida a la de cerámicos, siempre abierta salvo que se pida otra cosa. */
export function testConfigInput(
  channelIds: string[],
  overrides: Partial<TenantConfigInput> = {},
): TenantConfigInput {
  return {
    schema_version: 1,
    ai: { enabled: true, channel_ids: channelIds },
    business: {
      name: 'Cerámicos de Prueba',
      industry: 'materiales para la construcción',
      language: 'es',
      branches: [{ name: 'Centro', address: 'Calle Falsa 123', hours: OPEN_WEEK, phone: '+542235550100' }],
      service_hours: OPEN_WEEK,
      payment_methods: ['Efectivo con 10 % de descuento pagando en efectivo', 'Tarjeta de crédito'],
      shipping: 'Envíos a domicilio dentro de la ciudad.',
      website: 'https://www.ceramicos-prueba.test',
      email: 'ventas@ceramicos-prueba.test',
    },
    knowledge: {
      faqs: [{ question: '¿Hacen envíos?', answer: 'Sí, dentro de la ciudad.' }],
      policies: {
        returns: 'Cambios dentro de los 30 días con ticket.',
        warranty: null,
        shipping: null,
        financing: null,
      },
    },
    agent: {
      persona: { name: null, tone: 'cordial y breve' },
      custom_instructions: '',
      sales_guidance: 'Si compra porcelanato, ofrecé pegamento y pastina.',
      business_rules: [],
      offers: [],
      must_not: [],
    },
    qualification: {
      fields: [
        {
          key: 'producto_ambiente',
          label: 'Producto o ambiente',
          type: 'string',
          how_to_ask: '¿Para qué ambiente es?',
          required: true,
          priority: 1,
        },
        {
          key: 'm2',
          label: 'Metros cuadrados',
          type: 'number',
          how_to_ask: '¿Cuántos m² necesitás, más o menos?',
          required: true,
          priority: 2,
        },
        {
          key: 'fecha_compra',
          label: 'Fecha estimada de compra',
          type: 'date',
          how_to_ask: '¿Para cuándo lo necesitás?',
          required: true,
          priority: 3,
        },
        {
          key: 'nombre',
          label: 'Nombre',
          type: 'string',
          how_to_ask: '¿Cómo es tu nombre?',
          required: false,
          priority: 4,
        },
      ],
      discovery_guidance: '',
      max_questions_per_message: 2,
      max_qualification_turns: 6,
      max_turns_when_hot: 2,
    },
    scoring: {
      dimensions: [
        { key: 'intent', description: 'intención de compra', weight: 3 },
        { key: 'urgency', description: 'urgencia', weight: 2 },
        { key: 'volume', description: 'volumen', weight: 2 },
        { key: 'fit', description: 'encaja con lo que vende el negocio', weight: 1 },
      ],
      completeness_weight: 2,
      thresholds: { hot: 70, warm: 40 },
    },
    handoff: {
      triggers: {
        asks_human: immediate,
        availability: immediate,
        payment_or_reservation: immediate,
        price_negotiation: immediate,
        complaint: immediate,
        frustration: immediate,
        cannot_answer: immediate,
      },
      custom_triggers: [],
      message_in_hours: MSG_IN_HOURS,
      message_after_hours: MSG_AFTER_HOURS,
      qualify_after_hours: true,
      unsupported_media: { mode: 'ask_text', message: MEDIA_ASK },
    },
    ...overrides,
  };
}

export function testConfig(
  channelIds: string[] = [],
  overrides: Partial<TenantConfigInput> = {},
): TenantConfig {
  return tenantConfigSchema.parse(testConfigInput(channelIds, overrides));
}

/** availability en modo after_fields [m2, nombre] con intro solo en español. */
export function withAvailabilityAfterFields(input: TenantConfigInput): TenantConfigInput {
  return {
    ...input,
    handoff: {
      ...input.handoff,
      triggers: {
        ...input.handoff.triggers,
        availability: {
          enabled: true,
          mode: { type: 'after_fields', fields: ['m2', 'nombre'], intro: { es: AVAILABILITY_INTRO } },
        },
      },
    },
  };
}

/** Salida del modelo válida, sin señales ni datos; se pisa lo que haga falta. */
export function agentOutput(config: TenantConfig, overrides: Partial<AgentOutput> = {}): AgentOutput {
  return {
    signals: Object.fromEntries(config.scoring.dimensions.map((d) => [d.key, { score: 0, evidence: null }])),
    extracted: Object.fromEntries(config.qualification.fields.map((f) => [f.key, null])),
    discovered: [],
    language: 'es',
    triggers: [],
    action: 'none',
    replies: [],
    asks_field: null,
    declined_fields: [],
    suggestion: null,
    handoff_summary: 'Cliente consultando.',
    reason: null,
    ...overrides,
  };
}

/** Señales iguales en todas las dimensiones. */
export function signals(config: TenantConfig, score: number): AgentOutput['signals'] {
  return Object.fromEntries(config.scoring.dimensions.map((d) => [d.key, { score, evidence: null }]));
}

type Responder = (
  request: LlmRequest<AgentOutput>,
) => AgentOutput | LlmError | Promise<AgentOutput | LlmError>;

/** LlmClient falso: guarda los pedidos y devuelve lo que diga `respond` (validado con el schema real). */
export class FakeLlm implements LlmClient {
  readonly provider = 'openrouter' as const;
  requests: LlmRequest<AgentOutput>[] = [];
  respond: Responder = () => {
    throw new Error('FakeLlm sin respuesta configurada');
  };

  async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    const typed = request as unknown as LlmRequest<AgentOutput>;
    this.requests.push(typed);
    const answer = await this.respond(typed);
    if (answer instanceof LlmError) throw answer;
    const parsed = typed.schema.zod.parse(answer);
    return {
      parsed: parsed as unknown as T,
      usage: { inputTokens: 1200, outputTokens: 150 },
      costUsd: '0.0002',
      costSource: 'provider',
      provider: 'openrouter',
      model: request.model,
      latencyMs: 5,
      toolCalls: [],
    };
  }
}

export class FakeLlmFactory implements LlmClientFactory {
  constructor(readonly client: FakeLlm) {}

  async forTenant(): Promise<LlmSelection> {
    return { client: this.client, model: ALLOWED_MODELS[0]!, billingMode: 'platform' };
  }
}

/** PresenceService falso: registra cuándo la IA puso y sacó el "escribiendo…". */
export class FakePresence {
  events: { kind: 'start' | 'stop'; conversationId: string }[] = [];
  /** Lo que devuelve startTyping (null = no se pudo mostrar). */
  typingSince: Date | null = null;

  async startTyping(_tenantId: string, conversationId: string): Promise<Date | null> {
    this.events.push({ kind: 'start', conversationId });
    return this.typingSince ?? new Date();
  }

  async stopTyping(_tenantId: string, conversationId: string): Promise<void> {
    this.events.push({ kind: 'stop', conversationId });
  }

  of(conversationId: string) {
    return this.events.filter((event) => event.conversationId === conversationId).map((event) => event.kind);
  }
}

export const charged = (costUsd = '0.0003') => ({
  usage: { inputTokens: 1000, outputTokens: 900 },
  costUsd,
  costSource: 'provider' as const,
  model: ALLOWED_MODELS[0]!.id,
  latencyMs: 7,
});

/** Mensaje en la conversación (como ventas_app). Devuelve el id. */
export async function addMessage(
  ctx: TestContext,
  chat: { tenantId: string; conversationId: string; channelId: string },
  options: { text?: string | null; type?: string; from?: 'contact' | 'user' | 'ai' | 'app' } = {},
): Promise<string> {
  const from = options.from ?? 'contact';
  const inbound = from === 'contact';
  return withTenant(ctx, chat.tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type, type,
         body, status, raw, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, clock_timestamp()) RETURNING id`,
      [
        chat.tenantId,
        chat.conversationId,
        chat.channelId,
        `${inbound ? 'false' : 'true'}_${uid().toUpperCase()}`,
        inbound ? 'inbound' : 'outbound',
        from,
        options.type ?? 'text',
        options.text === undefined ? 'Hola' : options.text,
        inbound ? 'received' : 'sent',
      ],
    );
    if (inbound) {
      await c.query(
        'UPDATE conversations SET last_inbound_at = now(), last_message_at = now() WHERE id = $1',
        [chat.conversationId],
      );
    }
    return rows[0]!.id;
  });
}
