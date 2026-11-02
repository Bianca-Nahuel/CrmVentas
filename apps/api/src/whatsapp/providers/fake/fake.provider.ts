import { randomUUID } from 'node:crypto';
import type { WhatsAppEvent } from '@ventas/shared';
import type {
  ConnectionResult,
  NormalizeResult,
  PairingQr,
  PresenceResult,
  SendResult,
  WhatsAppCapabilities,
  WhatsAppProvider,
} from '../../provider.js';
import { normalizeWahaEvent } from '../waha/waha-normalize.js';
import { wahaSessionName } from '../waha/waha-session.js';
import { FAKE_QR_IMAGE } from './fake-qr.js';

const FAKE_CAPABILITIES: WhatsAppCapabilities = {
  templates: false,
  within24hWindowOnly: false,
  adAttribution: false,
  outboundCampaigns: false,
  pairing: 'qr',
};

/**
 * Proveedor falso para los e2e del panel (WHATSAPP_FAKE_PROVIDER=true, nunca en producción): ocupa el
 * lugar de WAHA y no sale a la red. Todo envío "sale" al instante con un id inventado y la presencia
 * siempre funciona. Los webhooks se siguen leyendo con el formato de WAHA (normalize es pura).
 *
 * Conexión: las sesiones viven en memoria y muestran un QR de mentira. El escaneo se simula como en
 * producción, con un webhook session.status firmado (WORKING con me.id): ver los helpers de los tests y
 * de Playwright. Las sesiones que la API no abrió en este proceso (por ejemplo, las del seed) no tienen QR.
 */
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly id = 'waha' as const;
  readonly connectionType = 'unofficial' as const;
  readonly capabilities = FAKE_CAPABILITIES;

  /** Sesiones abiertas esperando el escaneo (los tests las consultan). */
  readonly sessions = new Set<string>();

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

  sessionIdFor(channelId: string): string {
    return wahaSessionName(channelId);
  }

  async openSession(externalId: string): Promise<ConnectionResult> {
    this.sessions.add(externalId);
    return { ok: true };
  }

  async restartPairing(externalId: string): Promise<ConnectionResult> {
    this.sessions.add(externalId);
    return { ok: true };
  }

  async getPairingQr(externalId: string): Promise<PairingQr> {
    return this.sessions.has(externalId) ? { state: 'qr', image: FAKE_QR_IMAGE } : { state: 'expired' };
  }

  async closeSession(externalId: string): Promise<ConnectionResult> {
    this.sessions.delete(externalId);
    return { ok: true };
  }
}
