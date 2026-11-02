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
  /**
   * Cómo se vincula un número: `qr` (se escanea desde el teléfono, como WhatsApp Web) o `embedded_signup`
   * (alta embebida de Meta). Los métodos de conexión de abajo solo sirven con `qr`.
   */
  pairing: 'qr' | 'embedded_signup';
}

/** Resultado de una acción sobre la sesión. `code`: corto, para logs, sin datos personales. */
export type ConnectionResult = { ok: true } | { ok: false; code: string };

/**
 * Estado de la vinculación por QR, tal como lo ve el proveedor:
 * - qr:          el código vigente (`data:image/png;base64,...`). Cambia solo cada pocos segundos.
 * - starting:    la sesión está arrancando; el QR todavía no está.
 * - connected:   ya hay un teléfono vinculado.
 * - expired:     la sesión se detuvo o falló (por ejemplo, se agotaron los QR): hace falta uno nuevo.
 * - unavailable: no se pudo consultar al proveedor.
 * El QR nunca se guarda ni se loguea: quien lo tiene puede vincular su teléfono a la sesión.
 */
export type PairingQr =
  | { state: 'qr'; image: string }
  | { state: 'starting' }
  | { state: 'connected' }
  | { state: 'expired' }
  | { state: 'unavailable'; code: string };

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
  /** Lo que se guarda en channels.connection_type (y exige aceptar el riesgo si es `unofficial`). */
  readonly connectionType: 'unofficial' | 'official';
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
  // Conexión por QR (capabilities.pairing = 'qr'). Nunca lanzan: todo error vuelve tipado. El número
  // vinculado no sale de acá sino del evento session.status (decisión #27).
  /** Identificador de la sesión del canal en el proveedor (channels.external_id): lo genera el sistema. */
  sessionIdFor(channelId: string): string;
  /** Crea e inicia la sesión con su webhook firmado; queda esperando el escaneo. */
  openSession(externalId: string): Promise<ConnectionResult>;
  /** Desvincula lo que hubiera y vuelve a iniciar la sesión con un QR nuevo (la crea si no existe). */
  restartPairing(externalId: string): Promise<ConnectionResult>;
  getPairingQr(externalId: string): Promise<PairingQr>;
  /**
   * Desvincula el teléfono y detiene la sesión. Con `forget`, además la borra del proveedor (canal
   * cancelado). Que la sesión ya no exista cuenta como éxito.
   */
  closeSession(externalId: string, options: { forget: boolean }): Promise<ConnectionResult>;
}

/** Token de inyección con todos los proveedores registrados. */
export const WHATSAPP_PROVIDER_REGISTRY = Symbol('WHATSAPP_PROVIDER_REGISTRY');
export type WhatsAppProviderRegistry = ReadonlyMap<WhatsAppProviderId, WhatsAppProvider>;
