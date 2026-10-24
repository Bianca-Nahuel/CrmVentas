// Utilidades de los tests de envío, ecos y acuses (tarea 005): datos de una empresa con un canal
// conectado, un contacto y una conversación; proveedor y pg-boss falsos.
import { randomBytes } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import type {
  ChatTarget,
  PresenceResult,
  SeenMessage,
  SendResult,
  WhatsAppProvider,
  WhatsAppProviderRegistry,
} from '../src/whatsapp/provider.js';
import { normalizeWahaEvent } from '../src/whatsapp/providers/waha/waha-normalize.js';
import { createTenant, createUser, withTenant, type TestContext } from './helpers.js';

export interface Chat {
  tenantId: string;
  ownerId: string;
  channelId: string;
  session: string;
  contactId: string;
  conversationId: string;
  /** E.164 del contacto. */
  waId: string;
  /** Solo dígitos (para armar payloads de WAHA). */
  phoneDigits: string;
}

export const uid = () => randomBytes(8).toString('hex');

/** Número ficticio único: +54 9 11 + 8 dígitos al azar. */
export function fakePhone(): string {
  return `54911${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, '0')}`;
}

/** Empresa nueva con un canal WAHA conectado. */
export async function createChannelTenant(ctx: TestContext, label: string) {
  const ownerId = (await createUser(ctx, `out-owner-${label}`)).id;
  const tenantId = await createTenant(ctx, `out-${label}`, ownerId);
  const session = `${ctx.prefix}_out_${label}`;
  const channelId = await withTenant(ctx, tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type, external_id,
         status, risk_accepted_at, risk_accepted_by)
       VALUES ($1, 'ventas', '+5491100000099', 'waha', 'unofficial', $2, 'connected', now(), $3)
       RETURNING id`,
      [tenantId, session, ownerId],
    );
    return rows[0]!.id;
  });
  return { tenantId, ownerId, channelId, session };
}

/**
 * Contacto y conversación abierta en el canal. lastInboundAgo: hace cuánto escribió el contacto (SQL
 * interval) o null si nunca escribió.
 */
export async function createChat(
  ctx: TestContext,
  channel: { tenantId: string; ownerId: string; channelId: string; session: string },
  options: { lastInboundAgo?: string | null; blocked?: boolean } = {},
): Promise<Chat> {
  const phoneDigits = fakePhone();
  const waId = `+${phoneDigits}`;
  const lastInboundAgo = options.lastInboundAgo === undefined ? '1 hour' : options.lastInboundAgo;
  return withTenant(ctx, channel.tenantId, async (c) => {
    const contact = await c.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, wa_id, blocked, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, now(), now()) RETURNING id`,
      [channel.tenantId, waId, options.blocked ?? false],
    );
    const contactId = contact.rows[0]!.id;
    const conversation = await c.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, channel_id, contact_id, last_message_at, last_inbound_at)
       VALUES ($1, $2, $3, now(), now() - $4::interval) RETURNING id`,
      [channel.tenantId, channel.channelId, contactId, lastInboundAgo],
    );
    return { ...channel, contactId, conversationId: conversation.rows[0]!.id, waId, phoneDigits };
  });
}

export interface ProviderCall {
  method: 'markSeen' | 'startTyping' | 'stopTyping' | 'sendText';
  target: ChatTarget;
  text?: string;
  /** markSeen: los external_id de los entrantes que se marcan. */
  seen?: string[];
}

/** Proveedor falso: registra las llamadas y cuántos sendText hubo en paralelo. */
export class FakeProvider implements WhatsAppProvider {
  readonly id = 'waha' as const;
  readonly capabilities = {
    templates: false,
    within24hWindowOnly: false,
    adAttribution: false,
    outboundCampaigns: false,
  };
  calls: ProviderCall[] = [];
  inFlight = 0;
  maxInFlight = 0;
  presence: PresenceResult = { ok: true };
  /** Lo que devuelve sendText; por defecto, ok con un id nuevo. */
  sendResult: (() => Promise<SendResult> | SendResult) | null = null;
  /** Se corre dentro de sendText, antes de devolver (para simular carreras). */
  duringSend: (() => Promise<void>) | null = null;
  sendDelayMs = 0;

  normalize(raw: unknown) {
    return normalizeWahaEvent(raw);
  }

  async enrich<T>(event: T): Promise<T> {
    return event;
  }

  async sendText(target: ChatTarget & { text: string }): Promise<SendResult> {
    this.calls.push({
      method: 'sendText',
      target: { channelExternalId: target.channelExternalId, waId: target.waId },
      text: target.text,
    });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
      if (this.duringSend) await this.duringSend();
      if (this.sendResult) return await this.sendResult();
      return { ok: true, externalId: `true_${uid().toUpperCase()}`, sentAt: new Date().toISOString() };
    } finally {
      this.inFlight--;
    }
  }

  async markSeen(target: ChatTarget & { messages: SeenMessage[] }): Promise<PresenceResult> {
    this.calls.push({
      method: 'markSeen',
      target: { channelExternalId: target.channelExternalId, waId: target.waId },
      seen: target.messages.map((message) => message.externalId),
    });
    return this.presence;
  }

  async startTyping(target: ChatTarget): Promise<PresenceResult> {
    this.calls.push({ method: 'startTyping', target });
    return this.presence;
  }

  async stopTyping(target: ChatTarget): Promise<PresenceResult> {
    this.calls.push({ method: 'stopTyping', target });
    return this.presence;
  }

  sends(): ProviderCall[] {
    return this.calls.filter((call) => call.method === 'sendText');
  }
}

export function registryWith(provider: WhatsAppProvider): WhatsAppProviderRegistry {
  return new Map([['waha', provider]]);
}

export interface SentJob {
  name: string;
  data: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

/** pg-boss falso: guarda lo que se encola (reprogramaciones). */
export function fakeBoss(): { boss: PgBoss; sent: SentJob[] } {
  const sent: SentJob[] = [];
  const boss = {
    async send(name: string, data: Record<string, unknown>, options?: Record<string, unknown>) {
      sent.push({ name, data, options });
      return uid();
    },
  } as unknown as PgBoss;
  return { boss, sent };
}

export const attempt = (id = uid(), retryCount = 0, retryLimit = 5) => ({ id, retryCount, retryLimit });
