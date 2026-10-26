// Modelos que una empresa puede usar. Solo entran los que pasaron los evals (skill cambio-prompt-ia).
// Los precios sirven para la estimación previa del AiBudgetGuard; el costo real lo informa el proveedor
// (OpenRouter) o se calcula con estos precios (Anthropic/OpenAI, tarea 009).

export const LLM_PROVIDERS = ['openrouter', 'anthropic', 'openai'] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

export interface AllowedModel {
  provider: LlmProviderId;
  /** Id del modelo en la API del proveedor. */
  id: string;
  structuredOutputs: boolean;
  tools: boolean;
  /**
   * Cómo devuelve la salida estructurada en un turno con herramientas (catálogo, tarea 007):
   * - response_format: herramientas y response_format en la misma llamada (pasó --tools-probe);
   * - final_tool: sin response_format; la salida es una herramienta final forzada (plan B);
   * - unsupported: ninguna de las dos anduvo o no se probó: los turnos con catálogo van a
   *   CATALOG_FALLBACK_MODEL_ID (regla de ruteo de LlmClientFactory).
   */
  catalogTools: 'response_format' | 'final_tool' | 'unsupported';
  /**
   * Esfuerzo de razonamiento que se pide. Estos modelos razonan por defecto (DeepSeek en high, Haiku y
   * GPT-6 Luna en medium) y esos tokens cuentan contra el tope de salida.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** USD por millón de tokens, en texto decimal (nunca float hacia la base). */
  inputUsdPerMTok: string;
  outputUsdPerMTok: string;
  priceSource: string;
  priceDate: string;
}

/**
 * Pasaron los evals de la tarea 006 (~75/76 casos y todas las metas, evals/README.md). El primero es el
 * recomendado (AI_DEFAULT_MODEL): el de conversación más natural. Haiku queda también para usarlo con la
 * clave propia de Anthropic (tarea 009); GPT-6 Luna es la opción más barata, con un tono más seco.
 */
export const ALLOWED_MODELS: readonly AllowedModel[] = [
  {
    provider: 'openrouter',
    id: 'deepseek/deepseek-v4.1-flash',
    structuredOutputs: true,
    tools: true,
    catalogTools: 'unsupported',
    reasoningEffort: 'low',
    inputUsdPerMTok: '0.02',
    outputUsdPerMTok: '1.00',
    priceSource: 'https://openrouter.ai/api/v1/models',
    priceDate: '2026-10-26',
  },
  {
    provider: 'openrouter',
    id: 'anthropic/claude-haiku-5.5',
    structuredOutputs: true,
    tools: true,
    catalogTools: 'response_format',
    reasoningEffort: 'low',
    inputUsdPerMTok: '0.10',
    outputUsdPerMTok: '0.50',
    priceSource: 'https://openrouter.ai/api/v1/models',
    priceDate: '2026-10-25',
  },
  {
    provider: 'openrouter',
    id: 'openai/gpt-6-luna',
    structuredOutputs: true,
    tools: true,
    catalogTools: 'unsupported',
    reasoningEffort: 'low',
    inputUsdPerMTok: '0.10',
    outputUsdPerMTok: '0.50',
    priceSource: 'https://openrouter.ai/api/v1/models',
    priceDate: '2026-10-26',
  },
];

/**
 * Modelos en evaluación: solo los usa el runner de evals (`npm run evals`); ninguna empresa los puede
 * elegir hasta que pasen y se muevan a ALLOWED_MODELS. Gemini 3.8 Flash quedó afuera por costo (~5 veces
 * DeepSeek); Claude Sonnet 5.5 se descartó por costo (~20 veces).
 */
export const CANDIDATE_MODELS: readonly AllowedModel[] = [
  {
    provider: 'openrouter',
    id: 'google/gemini-3.8-flash',
    structuredOutputs: true,
    tools: true,
    catalogTools: 'unsupported',
    reasoningEffort: 'low',
    inputUsdPerMTok: '0.825',
    outputUsdPerMTok: '4.125',
    priceSource: 'https://openrouter.ai/api/v1/models',
    priceDate: '2026-10-26',
  },
];

/**
 * Modelo de los turnos con catálogo cuando el de la empresa no maneja herramientas con salida estructurada
 * (catalogTools = unsupported). Haiku pasó --tools-probe con response_format (2026-10-26).
 */
export const CATALOG_FALLBACK_MODEL_ID = 'anthropic/claude-haiku-5.5';

export function findAllowedModel(
  id: string,
  provider: LlmProviderId = 'openrouter',
): AllowedModel | undefined {
  return ALLOWED_MODELS.find((model) => model.id === id && model.provider === provider);
}
