import type { WhatsAppEvent } from '@ventas/shared';
import {
  PRESENCE_TIMEOUT_MS,
  SEND_TIMEOUT_MS,
  type ChatTarget,
  type ConnectionResult,
  type NormalizeResult,
  type PairingQr,
  type PresenceResult,
  type SeenMessage,
  type SendResult,
  type SessionState,
  type WhatsAppCapabilities,
  type WhatsAppProvider,
} from '../../provider.js';
import type { WahaClient } from './waha-client.js';
import { normalizeWahaEvent } from './waha-normalize.js';
import {
  isNotFound,
  isOk,
  isUnprocessable,
  pairingFromQr,
  pairingFromSession,
  sessionStateFrom,
  toConnectionResult,
} from './waha-pairing.js';
import { toPresenceResult, toSendResult, wahaChatId, wahaSeenRequest } from './waha-send.js';
import { wahaSessionFor, wahaSessionName, type WahaWebhookSettings } from './waha-session.js';

function sessionPath(externalId: string): string {
  return `/api/sessions/${encodeURIComponent(externalId)}`;
}

// Conexión no oficial: solo responder, sin campañas ni plantillas (ver CLAUDE.md).
const WAHA_CAPABILITIES: WhatsAppCapabilities = {
  templates: false,
  within24hWindowOnly: false,
  adAttribution: false,
  outboundCampaigns: false,
  pairing: 'qr',
};

export class WahaProvider implements WhatsAppProvider {
  readonly id = 'waha' as const;
  readonly connectionType = 'unofficial' as const;
  readonly capabilities = WAHA_CAPABILITIES;

  constructor(
    private readonly client: WahaClient,
    private readonly webhook: WahaWebhookSettings,
  ) {}

  sessionIdFor(channelId: string): string {
    return wahaSessionName(channelId);
  }

  async openSession(externalId: string): Promise<ConnectionResult> {
    const created = await this.client.sessionCall('POST', '/api/sessions', {
      ...wahaSessionFor(this.webhook, externalId),
      start: true,
    });
    return toConnectionResult(created);
  }

  // Detener → desvincular → reaplicar la configuración (con la sesión detenida, PUT no la arranca) →
  // iniciar. Si la sesión ya no existe en WAHA, se crea de nuevo con el mismo nombre.
  async restartPairing(externalId: string): Promise<ConnectionResult> {
    const path = sessionPath(externalId);
    const stopped = await this.client.sessionCall('POST', `${path}/stop`);
    if (isNotFound(stopped)) return this.openSession(externalId);
    if (!isOk(stopped)) return toConnectionResult(stopped);
    const loggedOut = await this.client.sessionCall('POST', `${path}/logout`);
    // 422: no había teléfono vinculado. Otro error podría dejar vinculado el teléfono anterior: no sigue.
    if (!isOk(loggedOut) && !isNotFound(loggedOut) && !isUnprocessable(loggedOut)) {
      return toConnectionResult(loggedOut);
    }
    const updated = await this.client.sessionCall('PUT', path, wahaSessionFor(this.webhook, externalId));
    if (!isOk(updated)) return toConnectionResult(updated);
    return toConnectionResult(await this.client.sessionCall('POST', `${path}/start`));
  }

  async getPairingQr(externalId: string): Promise<PairingQr> {
    const session = pairingFromSession(await this.client.sessionCall('GET', sessionPath(externalId)));
    if (session) return session;
    return pairingFromQr(
      await this.client.sessionCall('GET', `/api/${encodeURIComponent(externalId)}/auth/qr`),
    );
  }

  async getSessionState(externalId: string): Promise<SessionState> {
    return sessionStateFrom(await this.client.sessionCall('GET', sessionPath(externalId)));
  }

  // restart sirve tanto para STOPPED como para FAILED y no toca la vinculación guardada.
  async resumeSession(externalId: string): Promise<ConnectionResult> {
    return toConnectionResult(await this.client.sessionCall('POST', `${sessionPath(externalId)}/restart`));
  }

  async closeSession(externalId: string, options: { forget: boolean }): Promise<ConnectionResult> {
    const path = sessionPath(externalId);
    if (options.forget) {
      const deleted = await this.client.sessionCall('DELETE', path);
      return isNotFound(deleted) ? { ok: true } : toConnectionResult(deleted);
    }
    const loggedOut = await this.client.sessionCall('POST', `${path}/logout`);
    if (isNotFound(loggedOut)) return { ok: true };
    // 422: la sesión no tiene un teléfono vinculado (no está en WORKING). Cualquier otro error deja el
    // teléfono vinculado: no se da por cerrada (la cola reintenta).
    if (!isOk(loggedOut) && !isUnprocessable(loggedOut)) return toConnectionResult(loggedOut);
    const stopped = await this.client.sessionCall('POST', `${path}/stop`);
    return isNotFound(stopped) ? { ok: true } : toConnectionResult(stopped);
  }

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
