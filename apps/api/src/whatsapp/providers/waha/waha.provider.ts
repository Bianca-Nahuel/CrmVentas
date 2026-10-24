import type { WhatsAppEvent } from '@ventas/shared';
import type { NormalizeResult, WhatsAppCapabilities, WhatsAppProvider } from '../../provider.js';
import type { WahaClient } from './waha-client.js';
import { normalizeWahaEvent } from './waha-normalize.js';

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
    if (event.type !== 'message.received' || !event.contact.waId.endsWith('@lid')) return event;
    const phone = await this.client.findPhoneByLid(event.channelExternalId, event.contact.waId);
    return phone ? { ...event, contact: { ...event.contact, waId: phone } } : event;
  }
}
