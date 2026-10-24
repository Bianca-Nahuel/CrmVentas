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

// Campos comunes de un mensaje de un chat individual, entrante o propio.
interface MessageEventBase extends BaseEvent {
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

/** Mensaje que escribió el contacto. */
export interface MessageReceivedEvent extends MessageEventBase {
  type: 'message.received';
}

/**
 * Mensaje que salió del número del canal (eco): lo mandó el sistema o una persona desde el teléfono o
 * WhatsApp Web. `contact` es el otro extremo del chat (sin nombre: el perfil del eco es el nuestro).
 */
export interface MessageEchoEvent extends MessageEventBase {
  type: 'message.echo';
}

// Mismos valores que el CHECK de messages.status para los salientes.
export const MESSAGE_DELIVERY_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const;
export type MessageDeliveryStatus = (typeof MESSAGE_DELIVERY_STATUSES)[number];

/** Acuse de un mensaje propio (enviado, entregado, leído o error). */
export interface MessageStatusEvent extends BaseEvent {
  type: 'message.status';
  externalMessageId: string;
  status: MessageDeliveryStatus;
}

export interface SessionStatusEvent extends BaseEvent {
  type: 'session.status';
  status: ChannelConnectionStatus;
}

export type WhatsAppEvent = MessageReceivedEvent | MessageEchoEvent | MessageStatusEvent | SessionStatusEvent;
