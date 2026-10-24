// Envío por WAHA (engine NOWEB): chatId del contacto, traducción de errores y lectura de la respuesta
// de sendText. Funciones puras; las usa WahaProvider.
// Documentación: https://waha.devlike.pro/docs/how-to/send-messages/ y
// https://waha.devlike.pro/docs/overview/how-to-avoid-blocking/ (errores 463 y 475).
import type { PresenceResult, ProviderFailure, SendResult } from '../../provider.js';
import type { WahaCallOutcome } from './waha-client.js';
import { canonicalMessageId } from './waha-normalize.js';

/**
 * contacts.wa_id → chatId de WAHA: `+5491122334455` → `5491122334455@c.us`; `<n>@lid` tal cual.
 * Cualquier otra cosa → null (no se manda).
 */
export function wahaChatId(waId: string): string | null {
  const e164 = /^\+([1-9]\d{6,14})$/.exec(waId);
  if (e164) return `${e164[1]}@c.us`;
  return /^\d{1,30}@lid$/.test(waId) ? waId : null;
}

// "server returned error 463/475": restricción por contactos nuevos o cuota del ciclo. La sesión sigue
// conectada; no hay que reiniciarla ni re-vincularla, solo frenar los envíos del canal.
// Se busca la frase completa: un número suelto (por ejemplo, una línea `:475:` de un stack) pausaría el
// canal sin motivo.
const BLOCKED_RISK = /server returned error (463|475)\b/i;

function failure(error: ProviderFailure['error'], code: string): ProviderFailure {
  return { ok: false, error, code };
}

/**
 * Traducción de una falla de WAHA. Regla de oro: solo es `transient` lo que seguro no llegó a WAHA (no se
 * pudo conectar). Todo lo que WAHA (o un proxy) respondió sin un significado claro es `unknown_outcome`:
 * un 5xx, un timeout, un 3xx, un 401/403 o un 408 pueden haber pasado con el mensaje ya mandado.
 */
export function classifyWahaFailure(outcome: WahaCallOutcome): ProviderFailure | null {
  if (outcome.kind === 'not_sent') return failure('transient', outcome.code);
  if (outcome.kind === 'no_response') return failure('unknown_outcome', outcome.code);
  const { status, text } = outcome;
  const risk = BLOCKED_RISK.exec(text);
  if (risk && status >= 400) return failure('blocked_risk', `waha_${risk[1]}`);
  if (status >= 200 && status < 300) return null;
  const code = `http_${status}`;
  // 404: la sesión no existe; 422: la sesión no está WORKING.
  if (status === 404 || status === 422) return failure('session_down', code);
  // 429: WAHA lo rechazó por límite, no lo mandó; se reintenta con backoff.
  if (status === 429) return failure('rate_limited', code);
  if (status === 400) return failure('invalid_recipient', code);
  return failure('unknown_outcome', code);
}

export function toPresenceResult(outcome: WahaCallOutcome): PresenceResult {
  return classifyWahaFailure(outcome) ?? { ok: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Cuerpo de POST /api/sendSeen para NOWEB: el chat y los ids originales de los entrantes, tal como los
 * mandó WAHA en el webhook (messages.raw → payload.id y payload.from). Sin ninguno legible → null (no hay
 * nada que marcar).
 */
export function wahaSeenRequest(
  messages: { raw: unknown }[],
): { chatId: string; messageIds: string[] } | null {
  let chatId: string | null = null;
  const messageIds: string[] = [];
  for (const message of messages) {
    const payload = asRecord(asRecord(message.raw)?.payload);
    const id = payload?.id;
    const from = payload?.from;
    if (typeof id !== 'string' || typeof from !== 'string') continue;
    if (!/^false_[^_]+_[A-Za-z0-9]{1,128}$/.test(id) || !id.startsWith(`false_${from}_`)) continue;
    // Todos del mismo chat: se toma el del primero.
    chatId ??= from;
    if (from === chatId) messageIds.push(id);
  }
  return chatId && messageIds.length > 0 ? { chatId, messageIds } : null;
}

// messageTimestamp de Baileys: segundos como número, string o Long ({ low, high }).
function timestampSeconds(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d{1,12}$/.test(value)) return Number(value);
  const low = asRecord(value)?.low;
  return typeof low === 'number' ? low >>> 0 : null;
}

/**
 * Respuesta de POST /api/sendText → SendResult. En NOWEB es el mensaje de Baileys (`key.id`,
 * `messageTimestamp`); otros engines devuelven `id` serializado. El id se lleva al formato canónico de
 * los ecos y acuses (`true_<id>`). Sin id legible el mensaje pudo haber salido: `unknown_outcome`.
 */
export function toSendResult(outcome: WahaCallOutcome, now: () => Date = () => new Date()): SendResult {
  const failed = classifyWahaFailure(outcome);
  if (failed) return failed;
  let body: Record<string, unknown> | undefined;
  try {
    body = asRecord(JSON.parse((outcome as { text: string }).text));
  } catch {
    body = undefined;
  }
  const key = asRecord(body?.key);
  const keyId = typeof key?.id === 'string' && /^[A-Za-z0-9]{1,128}$/.test(key.id) ? key.id : null;
  const serialized =
    typeof body?.id === 'string' ? body.id : (asRecord(body?.id)?._serialized as string | undefined);
  const externalId = keyId ? `true_${keyId}` : serialized ? canonicalMessageId(serialized) : null;
  if (!externalId) return failure('unknown_outcome', 'no_message_id');
  const seconds = timestampSeconds(body?.messageTimestamp);
  const sentAt = seconds && seconds > 0 && seconds < 4_102_444_800 ? new Date(seconds * 1000) : now();
  return { ok: true, externalId, sentAt: sentAt.toISOString() };
}
