import { randomUUID } from 'node:crypto';
import type { WhatsAppEvent } from '@ventas/shared';
import type {
  NormalizeResult,
  PresenceResult,
  SendResult,
  WhatsAppCapabilities,
  WhatsAppProvider,
} from '../../provider.js';
import { normalizeWahaEvent } from '../waha/waha-normalize.js';

const FAKE_CAPABILITIES: WhatsAppCapabilities = {
  templates: false,
  within24hWindowOnly: false,
  adAttribution: false,
  outboundCampaigns: false,
};

/**
 * Proveedor falso para los e2e del panel (WHATSAPP_FAKE_PROVIDER=true, nunca en producción): ocupa el
 * lugar de WAHA y no sale a la red. Todo envío "sale" al instante con un id inventado y la presencia
 * siempre funciona. Los webhooks se siguen leyendo con el formato de WAHA (normalize es pura).
 */
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly id = 'waha' as const;
  readonly capabilities = FAKE_CAPABILITIES;

  normalize(raw: unknown): NormalizeResult {
    return normalizeWahaEvent(raw);
  }

  async enrich(event: WhatsAppEvent): Promise<WhatsAppEvent> {
    return event;
  }

  async sendText(): Promise<SendResult> {
    return {
      ok: true,
      externalId: `true_FAKE${randomUUID().replaceAll('-', '').toUpperCase()}`,
      sentAt: new Date().toISOString(),
    };
  }

  async markSeen(): Promise<PresenceResult> {
    return { ok: true };
  }

  async startTyping(): Promise<PresenceResult> {
    return { ok: true };
  }

  async stopTyping(): Promise<PresenceResult> {
    return { ok: true };
  }
}
