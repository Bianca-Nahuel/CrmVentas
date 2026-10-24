// Payload de WAHA (engine NOWEB, 2026.8.x) → eventos internos. Funciones puras.
// Formato documentado: https://waha.devlike.pro/docs/how-to/events/ — `_data` es interno del engine y
// solo se lee para lo que la parte documentada no trae (nombre del perfil, ubicación, número de un LID).
import type {
  ChannelConnectionStatus,
  MessageReceivedEvent,
  MessageType,
  SessionStatusEvent,
} from '@ventas/shared';
import { z } from 'zod';
import type { NormalizeResult } from '../../provider.js';

export type { NormalizeResult };

/** Forma mínima del sobre de un webhook de WAHA (la valida también el endpoint). */
export const wahaEnvelopeSchema = z.looseObject({
  id: z.string().min(1).max(200),
  event: z.string().min(1).max(100),
  session: z.string().min(1).max(200),
  payload: z.looseObject({}),
});
export type WahaEnvelope = z.infer<typeof wahaEnvelopeSchema>;

/** Eventos que se encolan; el resto se responde con 200 y se descarta en el endpoint. */
export const WAHA_PROCESSED_EVENTS = new Set(['message', 'session.status']);

const messagePayloadSchema = z.looseObject({
  id: z.string().min(1).max(500),
  // Segundos. Tope en 2100: un valor desmedido haría fallar toISOString() en cada reintento.
  timestamp: z.number().positive().max(4_102_444_800),
  from: z.string().min(1).max(200),
  fromMe: z.boolean(),
  participant: z.string().nullish(),
  body: z.string().nullish(),
  hasMedia: z.boolean().nullish(),
  media: z.looseObject({ mimetype: z.string().nullish() }).nullish(),
  _data: z.unknown().optional(),
});
type MessagePayload = z.infer<typeof messagePayloadSchema>;

const SESSION_STATUS_MAP: Record<string, ChannelConnectionStatus> = {
  WORKING: 'connected',
  STARTING: 'pending',
  SCAN_QR_CODE: 'pending',
  PASSKEY_REQUIRED: 'pending',
  PASSKEY_CONFIRMATION_REQUIRED: 'pending',
  STOPPED: 'disconnected',
  FAILED: 'disconnected',
};

const MAX_PROFILE_NAME = 200;

/**
 * `5491122334455@c.us`, `...@s.whatsapp.net` (con o sin `:dispositivo`) o solo dígitos → `+5491122334455`.
 * Cualquier otra cosa (LIDs, grupos, basura) → null.
 */
export function toE164(jid: string): string | null {
  const match = /^(\d+)(?::\d+)?(?:@(?:c\.us|s\.whatsapp\.net))?$/.exec(jid);
  if (!match) return null;
  const digits = match[1]!;
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

function ignored(reason: string, eventId: string | null): NormalizeResult {
  return { kind: 'ignored', reason, eventId };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Remitente que no es un contacto individual (no se procesa). */
function nonIndividualReason(payload: MessagePayload): string | null {
  const from = payload.from;
  if (from === 'status@broadcast') return 'status';
  if (from.endsWith('@g.us')) return 'group';
  if (from.endsWith('@newsletter')) return 'newsletter';
  if (from.endsWith('@broadcast')) return 'broadcast';
  return null;
}

/**
 * Identificador del contacto: E.164 si WAHA da el número; si llega solo un LID, el número que el engine
 * adjunta en `_data.key` (NOWEB: remoteJidAlt o senderPn); si tampoco, el LID tal cual (`<n>@lid`), que
 * WAHA acepta para responder. El worker después intenta resolverlo con la API de LIDs.
 */
function contactWaId(payload: MessagePayload): string | null {
  const direct = toE164(payload.from);
  if (direct) return direct;
  const lid = /^(\d{1,30})@lid$/.exec(payload.from);
  if (!lid) return null;
  const key = asRecord(asRecord(payload._data)?.key);
  for (const alt of [stringAt(key, 'remoteJidAlt'), stringAt(key, 'senderPn')]) {
    const e164 = alt ? toE164(alt) : null;
    if (e164) return e164;
  }
  return `${lid[1]}@lid`;
}

function profileName(payload: MessagePayload): string | null {
  const name = stringAt(asRecord(payload._data), 'pushName')?.trim();
  return name ? name.slice(0, MAX_PROFILE_NAME) : null;
}

function messageType(payload: MessagePayload): MessageType {
  const content = asRecord(asRecord(payload._data)?.message);
  if (content?.locationMessage || content?.liveLocationMessage) return 'location';
  if (content?.stickerMessage) return 'other';
  const mimetype = payload.media?.mimetype ?? '';
  if (payload.hasMedia || mimetype) {
    if (mimetype.startsWith('image/') || content?.imageMessage) return 'image';
    if (mimetype.startsWith('audio/') || content?.audioMessage) return 'audio';
    if (mimetype.startsWith('video/') || content?.videoMessage) return 'video';
    return 'document';
  }
  return payload.body ? 'text' : 'other';
}

function normalizeMessage(envelope: WahaEnvelope, raw: unknown): NormalizeResult {
  const parsed = messagePayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) return ignored('invalid_payload', envelope.id);
  const payload = parsed.data;

  if (payload.fromMe) return ignored('from_me', envelope.id);
  const nonIndividual = nonIndividualReason(payload);
  if (nonIndividual) return ignored(nonIndividual, envelope.id);

  const waId = contactWaId(payload);
  if (!waId) return ignored('invalid_sender', envelope.id);

  const type = messageType(payload);
  const event: MessageReceivedEvent = {
    type: 'message.received',
    provider: 'waha',
    channelExternalId: envelope.session,
    eventId: envelope.id,
    externalMessageId: payload.id,
    contact: { waId, profileName: profileName(payload) },
    messageType: type,
    // En multimedia, WAHA pone el epígrafe en body. La ubicación no tiene texto propio.
    body: type === 'location' ? null : payload.body || null,
    sentAt: new Date(payload.timestamp * 1000).toISOString(),
    raw,
  };
  return { kind: 'event', event };
}

function normalizeSessionStatus(envelope: WahaEnvelope): NormalizeResult {
  const wahaStatus = stringAt(envelope.payload, 'status');
  const status = wahaStatus ? SESSION_STATUS_MAP[wahaStatus] : undefined;
  if (!status) return ignored('unknown_status', envelope.id);
  const event: SessionStatusEvent = {
    type: 'session.status',
    provider: 'waha',
    channelExternalId: envelope.session,
    eventId: envelope.id,
    status,
  };
  return { kind: 'event', event };
}

export function normalizeWahaEvent(raw: unknown): NormalizeResult {
  const parsed = wahaEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return ignored('invalid_envelope', null);
  const envelope = parsed.data;
  switch (envelope.event) {
    case 'message':
      return normalizeMessage(envelope, raw);
    case 'session.status':
      return normalizeSessionStatus(envelope);
    default:
      return ignored('unsupported_event', envelope.id);
  }
}
