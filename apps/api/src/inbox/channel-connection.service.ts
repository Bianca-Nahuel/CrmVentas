import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WhatsAppProviderId } from '@ventas/shared';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { channelEvents, channels } from '../db/schema/messaging.js';
import type { AppTx, TenantContext } from '../db/tenant-context.js';
import { publishNotice } from '../realtime/publish.js';
import {
  WHATSAPP_PROVIDER_REGISTRY,
  type ConnectionResult,
  type WhatsAppProvider,
  type WhatsAppProviderRegistry,
} from '../whatsapp/provider.js';
import type { ChannelPairing, CreateChannelBody } from './channels.contracts.js';
import { ChannelsService, type ChannelWithMembers } from './channels.service.js';

/** Tope de canales esperando el escaneo o conectados por empresa: cada uno es una sesión abierta en el proveedor. */
export const MAX_CHANNELS_PER_TENANT = 20;

interface ChannelRow {
  id: string;
  status: string;
  phoneNumber: string | null;
  connectedAt: Date | null;
  disconnectReason: string | null;
  provider: string;
  externalId: string | null;
}

/**
 * Conexión de números por QR (tarea 011): alta, QR, reconectar, desconectar, cancelar y levantar la pausa
 * de envíos. Corre dentro de la transacción del request (empresa activa, RLS): si el proveedor falla, la
 * excepción hace rollback y el canal queda como estaba.
 *
 * Nada acá pregunta qué proveedor es: el alta usa el que se vincula por QR (capabilities.pairing) y el
 * resto, el del canal. El número del canal nunca sale de acá: lo pone el worker de session.status con el
 * número que se escaneó (decisión #27). El QR no se guarda ni se loguea.
 */
@Injectable()
export class ChannelConnectionService {
  constructor(
    @Inject(WHATSAPP_PROVIDER_REGISTRY) private readonly providers: WhatsAppProviderRegistry,
    private readonly channels: ChannelsService,
  ) {}

  async create(tx: AppTx, context: TenantContext, body: CreateChannelBody): Promise<ChannelWithMembers> {
    const provider = [...this.providers.values()].find(
      (candidate) => candidate.capabilities.pairing === 'qr',
    );
    if (!provider) throw new ConflictException({ code: 'PAIRING_NOT_SUPPORTED' });

    await this.assertBelowLimit(tx, context);
    const idResult = await tx.execute<{ id: string }>(sql`SELECT uuidv7() AS id`);
    const channelId = idResult.rows[0]!.id;
    const externalId = provider.sessionIdFor(channelId);
    await tx.insert(channels).values({
      id: channelId,
      tenantId: context.tenantId,
      name: body.name,
      phoneNumber: null,
      provider: provider.id,
      connectionType: provider.connectionType,
      externalId,
      status: 'pending',
      // Quién conectó el número no oficial (los riesgos se acuerdan fuera del panel, decisión #101): el
      // usuario del request (app.user_id), nunca un dato del cliente.
      riskAcceptedAt: sql`now()`,
      riskAcceptedBy: sql`app_user_id()`,
    });
    await this.record(tx, context, channelId, 'created', {});
    assertProvider(await provider.openSession(externalId));
    await this.notify(tx, context, channelId);
    return this.channels.get(tx, channelId);
  }

  /**
   * QR vigente. Mientras la base no diga connected, se le pregunta al proveedor; si el proveedor ya ve el
   * teléfono vinculado pero el webhook todavía no llegó, se responde starting (el número sale del evento).
   * Un escaneo rechazado vuelve con su motivo, para que el diálogo explique lo mismo que la lista.
   */
  async pairing(tx: AppTx, channelId: string): Promise<ChannelPairing> {
    const channel = await this.lock(tx, channelId, { forUpdate: false });
    const empty = { qr: null, phoneNumber: null, disconnectReason: null, numberInUse: null };
    if (channel.status === 'connected') {
      return { ...empty, state: 'connected', phoneNumber: channel.phoneNumber };
    }
    if (channel.disconnectReason === 'phone_mismatch' || channel.disconnectReason === 'number_in_use') {
      const view = await this.channels.get(tx, channelId);
      return {
        ...empty,
        state: 'rejected',
        phoneNumber: view.phoneNumber,
        disconnectReason: view.disconnectReason,
        numberInUse: view.numberInUse,
      };
    }
    if (channel.status !== 'pending' || !channel.externalId) return { ...empty, state: 'expired' };
    const pairing = await this.providerFor(channel).getPairingQr(channel.externalId);
    switch (pairing.state) {
      case 'qr':
        return { ...empty, state: 'qr', qr: pairing.image };
      case 'connected':
        return { ...empty, state: 'starting' };
      default:
        return { ...empty, state: pairing.state };
    }
  }

  /** QR nuevo para el mismo canal (mismo historial). No vale para uno conectado o bloqueado. */
  async reconnect(tx: AppTx, context: TenantContext, channelId: string): Promise<ChannelWithMembers> {
    const channel = await this.lock(tx, channelId);
    if (channel.status === 'banned') throw new ConflictException({ code: 'CHANNEL_BANNED' });
    if (channel.status === 'connected') throw new ConflictException({ code: 'CHANNEL_CONNECTED' });
    const provider = this.providerFor(channel);
    if (channel.status === 'disconnected') await this.assertBelowLimit(tx, context);
    await tx
      .update(channels)
      .set({ status: 'pending', disconnectReason: null })
      .where(eq(channels.id, channelId));
    await this.record(tx, context, channelId, 'reconnect_requested', {});
    assertProvider(await provider.restartPairing(channel.externalId!));
    await this.notify(tx, context, channelId);
    return this.channels.get(tx, channelId);
  }

  /** Desvincula el teléfono en el proveedor y deja el canal desconectado (lo pidió una persona). */
  async disconnect(tx: AppTx, context: TenantContext, channelId: string): Promise<ChannelWithMembers> {
    const channel = await this.lock(tx, channelId);
    if (channel.status === 'banned') throw new ConflictException({ code: 'CHANNEL_BANNED' });
    if (channel.status === 'disconnected') throw new ConflictException({ code: 'CHANNEL_NOT_CONNECTED' });
    // Nunca se conectó: no hay teléfono que desvincular; lo que corresponde es cancelar el alta.
    if (channel.phoneNumber === null && channel.connectedAt === null) {
      throw new ConflictException({ code: 'CHANNEL_NEVER_CONNECTED' });
    }
    const provider = this.providerFor(channel);
    await tx
      .update(channels)
      .set({ status: 'disconnected', disconnectedAt: sql`now()`, disconnectReason: 'logged_out' })
      .where(eq(channels.id, channelId));
    await this.record(tx, context, channelId, 'disconnected', { by: 'user' });
    assertProvider(await provider.closeSession(channel.externalId!, { forget: false }));
    await this.notify(tx, context, channelId);
    return this.channels.get(tx, channelId);
  }

  /**
   * Cancela el alta de un número que nunca se conectó: borra el canal y la sesión del proveedor. Uno que
   * tuvo número o conversaciones no se borra (política delete_never_connected de 0020).
   */
  async cancel(tx: AppTx, context: TenantContext, channelId: string): Promise<void> {
    const channel = await this.lock(tx, channelId);
    if (channel.status === 'connected' || channel.phoneNumber !== null) {
      throw new ConflictException({ code: 'CHANNEL_HAS_HISTORY' });
    }
    const provider = this.providerFor(channel);
    const deleted = await tx
      .delete(channels)
      .where(eq(channels.id, channelId))
      .returning({ id: channels.id });
    if (deleted.length === 0) throw new ConflictException({ code: 'CHANNEL_HAS_HISTORY' });
    assertProvider(await provider.closeSession(channel.externalId!, { forget: true }));
    await this.notify(tx, context, channelId);
  }

  /** Levanta la pausa de envíos. No toca la sesión; queda registrado quién y cuándo. */
  async resumeSending(tx: AppTx, context: TenantContext, channelId: string): Promise<ChannelWithMembers> {
    await this.lock(tx, channelId);
    const [previous] = await tx
      .select({ reason: channels.sendingPausedReason })
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          isNotNull(channels.sendingPausedUntil),
          gt(channels.sendingPausedUntil, sql`now()`),
        ),
      );
    if (!previous) throw new ConflictException({ code: 'CHANNEL_NOT_PAUSED' });
    await tx
      .update(channels)
      .set({ sendingPausedUntil: null, sendingPausedReason: null })
      .where(eq(channels.id, channelId));
    // El motivo es un código (blocked_risk:463), sin datos personales.
    await this.record(tx, context, channelId, 'sending_resumed', { previousReason: previous.reason ?? '' });
    await this.notify(tx, context, channelId);
    return this.channels.get(tx, channelId);
  }

  /**
   * Tope de sesiones abiertas (pending o connected) por empresa; las desconectadas están detenidas en el
   * proveedor y no cuentan. Bloquea la empresa para contar sin carreras entre dos pedidos simultáneos.
   */
  private async assertBelowLimit(tx: AppTx, context: TenantContext): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`channels:${context.tenantId}`}, 0))`,
    );
    const count = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM channels WHERE status IN ('pending', 'connected')`,
    );
    if ((count.rows[0]?.n ?? 0) >= MAX_CHANNELS_PER_TENANT) {
      throw new ConflictException({ code: 'CHANNEL_LIMIT' });
    }
  }

  private async lock(tx: AppTx, channelId: string, options = { forUpdate: true }): Promise<ChannelRow> {
    const query = tx
      .select({
        id: channels.id,
        status: channels.status,
        phoneNumber: channels.phoneNumber,
        connectedAt: channels.connectedAt,
        disconnectReason: channels.disconnectReason,
        provider: channels.provider,
        externalId: channels.externalId,
      })
      .from(channels)
      .where(eq(channels.id, channelId));
    const [channel] = options.forUpdate ? await query.for('update') : await query;
    if (!channel) throw new NotFoundException({ code: 'NOT_FOUND' });
    return channel;
  }

  private providerFor(channel: ChannelRow): WhatsAppProvider {
    const provider = this.providers.get(channel.provider as WhatsAppProviderId);
    if (!provider || provider.capabilities.pairing !== 'qr' || !channel.externalId) {
      throw new ConflictException({ code: 'PAIRING_NOT_SUPPORTED' });
    }
    return provider;
  }

  private async record(
    tx: AppTx,
    context: TenantContext,
    channelId: string,
    type: 'created' | 'disconnected' | 'reconnect_requested' | 'sending_resumed',
    data: Record<string, string | boolean>,
  ): Promise<void> {
    await tx.insert(channelEvents).values({
      tenantId: context.tenantId,
      channelId,
      type,
      userId: sql`app_user_id()`,
      data,
    });
  }

  private notify(tx: AppTx, context: TenantContext, channelId: string): Promise<void> {
    return publishNotice(tx, {
      kind: 'channel',
      type: 'channel.updated',
      tenantId: context.tenantId,
      channelId,
    });
  }
}

/** El proveedor no hizo lo pedido: 502 (la transacción hace rollback). Solo el código, sin detalle. */
function assertProvider(result: ConnectionResult): void {
  if (!result.ok) throw new BadGatewayException({ code: 'PROVIDER_UNAVAILABLE' });
}
