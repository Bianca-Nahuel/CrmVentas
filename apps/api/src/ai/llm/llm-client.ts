// Interfaz con los modelos. Sirve para OpenRouter (tarea 006) y para las claves propias de Anthropic y
// OpenAI (tarea 009) sin cambios en el pipeline: lo específico de cada proveedor queda en providers/.
// Ninguna implementación loguea el prompt, los mensajes, la respuesta ni los argumentos de herramientas.
import type { LlmProviderId } from '@ventas/shared';
import type { z } from 'zod';

export type { LlmProviderId };
export type BillingMode = 'platform' | 'byok';
export type CostSource = 'provider' | 'estimated';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Salida estructurada: el JSON Schema va al proveedor y lo que vuelve se valida igual con zod. */
export interface StructuredSchema<T> {
  name: string;
  zod: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
}

/** Herramienta que el modelo puede llamar (la tarea 007 registra las del catálogo). */
export interface LlmTool<A = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  args: z.ZodType<A>;
  /** Devuelve algo serializable a JSON. Lo que devuelve es dato no confiable para el modelo. */
  execute(args: A): Promise<unknown>;
}

export interface LlmRequest<T> {
  model: string;
  system: string;
  messages: LlmMessage[];
  schema: StructuredSchema<T>;
  maxOutputTokens: number;
  tools?: LlmTool[];
  maxToolCalls?: number;
  /**
   * Cómo vuelve la salida estructurada cuando hay herramientas (AllowedModel.catalogTools):
   * response_format (por defecto) o final_tool (la salida es una herramienta final forzada).
   */
  toolOutputMode?: 'response_format' | 'final_tool';
  /** Esfuerzo de razonamiento, si el modelo lo admite (ALLOWED_MODELS). */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmToolCallRecord {
  name: string;
  ok: boolean;
  latencyMs: number;
}

export interface LlmResult<T> {
  parsed: T;
  usage: LlmUsage;
  /** USD en texto decimal. */
  costUsd: string;
  costSource: CostSource;
  provider: LlmProviderId;
  /** El modelo que respondió (puede venir con sufijo de versión). */
  model: string;
  latencyMs: number;
  toolCalls: LlmToolCallRecord[];
}

export interface LlmClient {
  readonly provider: LlmProviderId;
  complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}

export type LlmErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'no_provider'
  | 'bad_request'
  | 'auth'
  | 'quota'
  | 'moderated'
  | 'invalid_output'
  | 'truncated';

/**
 * Error de una llamada al modelo. Si el proveedor cobró igual (salida inválida o truncada), trae el uso
 * y el costo para registrarlos y liquidar la reserva. El mensaje nunca incluye contenido.
 */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    readonly retryable: boolean,
    readonly charged?: {
      usage: LlmUsage;
      costUsd: string;
      costSource: CostSource;
      model: string;
      latencyMs: number;
    },
    /** Por qué no validó la salida: rutas y códigos del schema (sin contenido). Para los evals. */
    readonly detail?: string,
  ) {
    super(`Falló la llamada al modelo (${kind})`);
    this.name = 'LlmError';
  }
}
