// Constantes del agente (tarea 006). Lo que cambia por negocio va en tenant_configs, no acá.

/** Espera antes de correr, para juntar mensajes seguidos del cliente (startAfter del trabajo). */
export const AI_DEBOUNCE_SECONDS = 10;

/** Mensajes del historial que ve el modelo, y largo máximo de cada uno. */
export const AI_HISTORY_MESSAGES = 20;
export const AI_MESSAGE_MAX_CHARS = 1_000;

/** Tope de una respuesta enviada como 'ai' (control de salida; con varias partes, del total). */
export const AI_REPLY_MAX_CHARS = 500;
/** Mensajes en que se puede partir una respuesta (tarea 010). */
export const AI_MAX_REPLY_PARTS = 2;
/** Preguntas por mensaje de la v3, aunque la config permita más (tarea 010). */
export const AI_MAX_QUESTIONS_PER_TURN = 1;
/** Tope después de poner los valores de las marcas del catálogo (precios con condición, links). */
export const AI_REPLY_RENDERED_MAX_CHARS = 900;

/**
 * Tokens de salida del modelo: señales + extracción + respuesta + resumen (~600) más el razonamiento, que
 * cuenta contra este tope. Con 900 los evals dieron respuestas cortadas (finish_reason length).
 */
export const AI_MAX_OUTPUT_TOKENS = 3_000;

/** Timeout de cada llamada HTTP al modelo y de un turno completo con herramientas. */
export const LLM_CALL_TIMEOUT_MS = 30_000;
export const LLM_TURN_TIMEOUT_MS = 60_000;

/** Llamadas a herramientas por turno; al llegar, la siguiente vuelta va con tool_choice 'none'. */
export const MAX_TOOL_CALLS_PER_TURN = 3;

/** Preguntas de un disparador after_fields sin que lleguen los datos: después deriva igual. */
export const AFTER_FIELDS_MAX_ASKS = 2;

/** Sugerencias de venta (agent.sales_guidance) por conversación. */
export const AGENT_MAX_SUGGESTIONS_PER_CONVERSATION = 2;

/** Resumen de derivación: el del modelo y el guardado (con el agregado del código). */
export const HANDOFF_SUMMARY_MODEL_MAX_CHARS = 800;
export const HANDOFF_SUMMARY_STORED_MAX_CHARS = 2_000;

/** Lo descubierto por la guía que se guarda por conversación. */
export const DISCOVERED_NOTES_MAX = 20;
