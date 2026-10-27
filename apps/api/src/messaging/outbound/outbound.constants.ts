// Reglas de envío para la conexión no oficial (tarea 005). Valores fijos por ahora; la ventana y la
// pausa de la IA pasan a la configuración de cada empresa en la tarea 009.
// Referencia: https://waha.devlike.pro/docs/overview/how-to-avoid-blocking/
import { PRESENCE_TIMEOUT_MS, SEND_TIMEOUT_MS } from '../../whatsapp/provider.js';

/** Solo se responde si el último entrante del contacto tiene menos de esto. */
export const REPLY_WINDOW_HOURS = 24;

/** Una persona respondió desde el teléfono: la IA no se mete en esa conversación por este tiempo. */
export const AI_PAUSE_AFTER_HUMAN_HOURS = 12;

/** "Escribiendo…": 1,5 s + 60 ms por carácter, ±25 % al azar, entre 2 y 8 s. */
export const TYPING_DELAY = {
  baseMs: 1_500,
  perCharMs: 60,
  jitter: 0.25,
  minMs: 2_000,
  maxMs: 8_000,
} as const;

/**
 * Un "escribiendo…" puesto antes (la IA pensando, PresenceService) se descuenta de la demora solo si
 * empezó hace menos que esto: WhatsApp saca el indicador solo a los ~25 s.
 */
export const TYPING_INDICATOR_MAX_MS = 20_000;

/** Envíos por canal en cualquier ventana de 60 s (se cuentan los claims, salgan o no). */
export const MAX_SENDS_PER_MINUTE_PER_CHANNEL = 6;
export const RATE_WINDOW_MS = 60_000;

/** Entre dos salientes seguidos al mismo chat (sin un entrante en el medio): 30–60 s al azar. */
export const SAME_CHAT_GAP_MS = { minMs: 30_000, maxMs: 60_000 } as const;

/**
 * Respuesta en varios mensajes (tarea 010): la parte siguiente no espera SAME_CHAT_GAP_MS, sino que sale
 * cuando salió la anterior, con su propio visto → "escribiendo…" (TYPING_DELAY). El límite por canal vale
 * igual. Mientras la anterior no salió, se vuelve a mirar en NEXT_PART_RECHECK_MS.
 */
export const NEXT_PART_START_AFTER_SECONDS = 1;
export const NEXT_PART_RECHECK_MS = 2_000;
/** Si la anterior no salió en este plazo desde que se armó la respuesta, la siguiente ya no va. */
export const NEXT_PART_MAX_WAIT_MS = 10 * 60_000;

/** Un envío en 'sending' más viejo que esto se da por trabado (unknown_outcome); nunca se reenvía. */
export const STUCK_SENDING_AFTER_MS = 120_000;

/** Ecos: si hay un envío en curso en el chat, se vuelve a mirar cada 5 s, hasta 6 veces. */
export const ECHO_RECHECK_DELAY_SECONDS = 5;
export const ECHO_RECHECK_MAX = 6;

/** Un eco con el mismo texto que un envío unknown_outcome de este lapso se reconcilia con él. */
export const ECHO_RECONCILE_WINDOW_MS = 120_000;

/**
 * Peor caso de un envío (sin contar las transacciones, < 1 s cada una): 38 s. Tiene que quedar debajo del
 * expireInSeconds de la cola whatsapp-outbound (60 s, drizzle/0007); lo controla un test.
 */
export const WORST_CASE_SEND_MS = 3 * PRESENCE_TIMEOUT_MS + TYPING_DELAY.maxMs + SEND_TIMEOUT_MS;

/** Demora de "escribiendo…" para un texto, con `random` en [0, 1). */
export function typingDelayMs(text: string, random: () => number): number {
  const { baseMs, perCharMs, jitter, minMs, maxMs } = TYPING_DELAY;
  const nominal = baseMs + perCharMs * [...text].length;
  const factor = 1 - jitter + 2 * jitter * random();
  return Math.round(Math.min(maxMs, Math.max(minMs, nominal * factor)));
}

export function sameChatGapMs(random: () => number): number {
  const { minMs, maxMs } = SAME_CHAT_GAP_MS;
  return Math.round(minMs + (maxMs - minMs) * random());
}
