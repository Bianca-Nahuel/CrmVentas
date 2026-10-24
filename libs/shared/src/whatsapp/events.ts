// Eventos normalizados de WhatsApp. Cada proveedor (WAHA, Cloud API) traduce su payload a estos tipos
// dentro de apps/api/src/whatsapp/providers/; el resto del sistema solo conoce esto.

export const WHATSAPP_PROVIDERS = ['waha', 'cloud_api'] as const;
export type WhatsAppProviderId = (typeof WHATSAPP_PROVIDERS)[number];

export const MESSAGE_TYPES = ['text', 'image', 'audio', 'video', 'document', 'location', 'other'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

// Mismos valores que el CHECK de channels.status, sin 'banned': un evento del proveedor nunca lo pone.
export const CHANNEL_CONNECTION_STATUSES = ['pending', 'connected', 'disconnected'] as const;
export type ChannelConnectionStatus = (typeof CHANNEL_CONNECTION_STATUSES)[number];

interface BaseEvent {
  provider: WhatsAppProviderId;
  /** Identificador del canal en el proveedor (sesión de WAHA, phone_number_id de Meta). */
  channelExternalId: string;
  /** Id del evento en el proveedor, para logs (nunca datos personales). */
  eventId: string;
}

export interface MessageReceivedEvent extends BaseEvent {
  type: 'message.received';
  /** Id del mensaje en el proveedor: clave de idempotencia junto con el canal. */
  externalMessageId: string;
  contact: {
    /** E.164 (+5491122334455) o, si el proveedor no da el número, su identificador opaco (`<n>@lid`). */
    waId: string;
    profileName: string | null;
  };
  messageType: MessageType;
  /** Texto, o epígrafe del multimedia si lo hay. */
  body: string | null;
  /** ISO 8601, del timestamp del mensaje (no de cuando llegó). */
  sentAt: string;
  /** Payload crudo del proveedor, se guarda en messages.raw. */
  raw: unknown;
}

export interface SessionStatusEvent extends BaseEvent {
  type: 'session.status';
  status: ChannelConnectionStatus;
}

export type WhatsAppEvent = MessageReceivedEvent | SessionStatusEvent;
