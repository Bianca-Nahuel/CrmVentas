import type { WhatsAppEvent } from '@ventas/shared';
import {
  PRESENCE_TIMEOUT_MS,
  SEND_TIMEOUT_MS,
  type ChatTarget,
  type NormalizeResult,
  type PresenceResult,
  type SeenMessage,
  type SendResult,
  type WhatsAppCapabilities,
  type WhatsAppProvider,
} from '../../provider.js';
import type { WahaClient } from './waha-client.js';
import { normalizeWahaEvent } from './waha-normalize.js';
import { toPresenceResult, toSendResult, wahaChatId, wahaSeenRequest } from './waha-send.js';

// Conexión no oficial: solo responder, sin campañas ni plantillas (ver CLAUDE.md).
const WAHA_CAPABILITIES: WhatsAppCapabilities = {
  templates: false,
  within24hWindowOnly: false,
  adAttribution: false,
  outboundCampaigns: false,
};

export class WahaProvider implements WhatsAppProvider {
  readonly id = 'waha' as const;
  readonly capabilities = WAHA_CAPABILITIES;

  constructor(private readonly client: WahaClient) {}

  normalize(raw: unknown): NormalizeResult {
    return normalizeWahaEvent(raw);
  }

  async enrich(event: WhatsAppEvent): Promise<WhatsAppEvent> {
    if (event.type !== 'message.received' && event.type !== 'message.echo') return event;
    if (!event.contact.waId.endsWith('@lid')) return event;
    const phone = await this.client.findPhoneByLid(event.channelExternalId, event.contact.waId);
    return phone ? { ...event, contact: { ...event.contact, waId: phone } } : event;
  }

  async sendText(target: ChatTarget & { text: string }): Promise<SendResult> {
    const chatId = wahaChatId(target.waId);
    if (!chatId) return { ok: false, error: 'invalid_recipient', code: 'invalid_chat_id' };
    const outcome = await this.client.chatAction(
      '/api/sendText',
      { session: target.channelExternalId, chatId, text: target.text, linkPreview: false },
      SEND_TIMEOUT_MS,
    );
    return toSendResult(outcome);
  }

  // NOWEB sin store no sabe qué mensajes tiene un chat: hay que pasarle los ids (los originales, con el
  // chat tal como llegó, que puede ser @lid aunque el contacto se guardó con su número).
  async markSeen(target: ChatTarget & { messages: SeenMessage[] }): Promise<PresenceResult> {
    const request = wahaSeenRequest(target.messages);
    if (!request) return { ok: true };
    const outcome = await this.client.chatAction(
      '/api/sendSeen',
      { session: target.channelExternalId, ...request },
      PRESENCE_TIMEOUT_MS,
    );
    return toPresenceResult(outcome);
  }

  startTyping(target: ChatTarget): Promise<PresenceResult> {
    return this.presence('/api/startTyping', target);
  }

  stopTyping(target: ChatTarget): Promise<PresenceResult> {
    return this.presence('/api/stopTyping', target);
  }

  private async presence(path: string, target: ChatTarget): Promise<PresenceResult> {
    const chatId = wahaChatId(target.waId);
    if (!chatId) return { ok: false, error: 'invalid_recipient', code: 'invalid_chat_id' };
    const outcome = await this.client.chatAction(
      path,
      { session: target.channelExternalId, chatId },
      PRESENCE_TIMEOUT_MS,
    );
    return toPresenceResult(outcome);
  }
}
