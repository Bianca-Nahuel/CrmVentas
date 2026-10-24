// Interfaz común de los proveedores de WhatsApp (WAHA, Cloud API). La lógica de negocio solo conoce
// esto y los eventos normalizados de @ventas/shared: lo que difiere entre proveedores se expresa con
// capabilities, nunca preguntando qué proveedor es.
import type { WhatsAppEvent, WhatsAppProviderId } from '@ventas/shared';

export interface WhatsAppCapabilities {
  /** Exige plantillas aprobadas fuera de la ventana de 24 h. */
  templates: boolean;
  /** Solo se puede responder dentro de las 24 h del último mensaje del contacto. */
  within24hWindowOnly: boolean;
  /** Informa de qué anuncio vino el contacto. */
  adAttribution: boolean;
  /** Permite campañas salientes (nunca en la conexión no oficial). */
  outboundCampaigns: boolean;
}

export type NormalizeResult =
  { kind: 'event'; event: WhatsAppEvent } | { kind: 'ignored'; reason: string; eventId: string | null };

/**
 * Por qué no salió un envío (o una llamada de presencia):
 * - transient:         seguro que no llegó al proveedor (no se pudo conectar); se puede reintentar.
 * - rate_limited:      el proveedor lo rechazó por límite; no salió, se reintenta con backoff.
 * - session_down:      el canal no está conectado en el proveedor.
 * - blocked_risk:      el proveedor avisa riesgo de bloqueo; hay que frenar los envíos del canal.
 * - invalid_recipient: el destino no sirve; reintentar no cambia nada.
 * - unknown_outcome:   el pedido pudo haber salido (timeout, 5xx, respuesta ilegible); nunca se reintenta.
 */
export const SEND_ERROR_KINDS = [
  'transient',
  'rate_limited',
  'session_down',
  'blocked_risk',
  'invalid_recipient',
  'unknown_outcome',
] as const;
export type SendErrorKind = (typeof SEND_ERROR_KINDS)[number];

/** `code`: identificador corto para logs y last_error (por ejemplo `http_500`), sin datos personales. */
export interface ProviderFailure {
  ok: false;
  error: SendErrorKind;
  code: string;
}

export type SendResult = { ok: true; externalId: string; sentAt: string } | ProviderFailure;
export type PresenceResult = { ok: true } | ProviderFailure;

// Tiempo máximo de cada llamada al proveedor. Todo proveedor los respeta: el worker de envío cuenta con
// ellos para terminar antes de que venza el trabajo (ver messaging/outbound/outbound.constants.ts).
export const PRESENCE_TIMEOUT_MS = 5_000;
export const SEND_TIMEOUT_MS = 15_000;

/** Un entrante para marcar como leído: messages.external_id y messages.raw (lo que mandó el proveedor). */
export interface SeenMessage {
  externalId: string;
  raw: unknown;
}

/** Chat de destino: el canal en el proveedor y el contacto (contacts.wa_id). */
export interface ChatTarget {
  channelExternalId: string;
  waId: string;
}

export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  readonly capabilities: WhatsAppCapabilities;
  /** Traduce el payload crudo del webhook (ya autenticado) a un evento interno. Pura. */
  normalize(raw: unknown): NormalizeResult;
  /**
   * Completa lo que requiere consultar al proveedor (por ejemplo, el número de un contacto que llegó
   * con un identificador opaco). Corre en el worker, antes de abrir la transacción. Un error de red
   * se propaga para que la cola reintente.
   */
  enrich(event: WhatsAppEvent): Promise<WhatsAppEvent>;
  // Envío. Nunca lanzan: todo error vuelve tipado. Solo los usa el worker de envío.
  /** Manda un texto. `externalId` tiene el mismo formato que el de los ecos y acuses de ese mensaje. */
  sendText(target: ChatTarget & { text: string }): Promise<SendResult>;
  /**
   * Marca como leídos los entrantes del chat que se pasan (los sin leer). Van con su `raw` porque cada
   * proveedor puede necesitar su id original (WAHA NOWEB sin store solo marca por id de mensaje).
   */
  markSeen(target: ChatTarget & { messages: SeenMessage[] }): Promise<PresenceResult>;
  startTyping(target: ChatTarget): Promise<PresenceResult>;
  stopTyping(target: ChatTarget): Promise<PresenceResult>;
}

/** Token de inyección con todos los proveedores registrados. */
export const WHATSAPP_PROVIDER_REGISTRY = Symbol('WHATSAPP_PROVIDER_REGISTRY');
export type WhatsAppProviderRegistry = ReadonlyMap<WhatsAppProviderId, WhatsAppProvider>;
