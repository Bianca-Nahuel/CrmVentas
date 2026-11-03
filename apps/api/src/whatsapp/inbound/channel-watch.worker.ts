// Vigía de reconexión de los números. Si la API o WAHA se reinician, la sesión pasa por STARTING (el canal
// queda "Reconectando") y el WORKING llega por webhook; si en ese momento la API no estaba, el webhook se
// pierde después de sus reintentos y el canal nunca vuelve a conectado. Cada minuto este trabajo le
// pregunta al proveedor por los canales no conectados que ya tuvieron número:
// - conectado → se aplica como un session.status normal (mismas reglas del número que el webhook);
// - detenido  → se reinicia la sesión conservando la vinculación (sin QR);
// - pide QR   → el teléfono se desvinculó: queda desconectado (session_failed) y no se reintenta más;
// - arrancando o sin respuesta → se vuelve a mirar en el próximo minuto.
// Nunca toca un canal que una persona desconectó, que espera un escaneo pedido desde el panel, bloqueado o
// con los envíos pausados (463/475: no se reinicia la sesión). Mismo esquema de encolado que
// import-files-purge (pg-boss sin programador, singletonSeconds). Logs: solo ids y resultados.
import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { SessionStatusEvent, WhatsAppProviderId } from '@ventas/shared';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { APP_DB, type AppDatabase } from '../../db/database.module.js';
import { channelEvents, channels } from '../../db/schema/messaging.js';
import { withTenantTransaction, type AppTx } from '../../db/tenant-context.js';
import { errorCode } from '../../jobs/error-code.js';
import { BOSS, QUEUES } from '../../jobs/jobs.module.js';
import { publishNotice } from '../../realtime/publish.js';
import { WHATSAPP_PROVIDER_REGISTRY, type WhatsAppProviderRegistry } from '../provider.js';
import { InboundService } from './inbound.service.js';

export const CHANNEL_WATCH_SECONDS = 60;

interface WatchedChannel {
  id: string;
  provider: string;
  externalId: string;
  status: string;
}

export type WatchResult =
  'conectado' | 'reiniciado' | 'requiere_qr' | 'arrancando' | 'sin_cambios' | 'proveedor_no_disponible';

@Injectable()
export class ChannelWatchWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ChannelWatch');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(APP_DB) private readonly database: AppDatabase,
    @Inject(WHATSAPP_PROVIDER_REGISTRY) private readonly providers: WhatsAppProviderRegistry,
    private readonly inbound: InboundService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.CHANNEL_WATCH_ENABLED) return;
    await this.boss.work(QUEUES.whatsappChannelWatch, { localConcurrency: 1 }, async () => {
      await this.run();
    });
    await this.schedule();
    this.timer = setInterval(() => void this.schedule(), CHANNEL_WATCH_SECONDS * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async schedule(): Promise<void> {
    try {
      await this.boss.send(QUEUES.whatsappChannelWatch, {}, { singletonSeconds: CHANNEL_WATCH_SECONDS });
    } catch (error) {
      this.logger.warn({ msg: 'channel-watch: no se pudo encolar', code: errorCode(error) });
    }
  }

  /** Revisa los canales de todas las empresas activas. Un error en uno no frena a los demás. */
  async run(): Promise<number> {
    const tenants = await this.database.db.execute<{ id: string }>(
      sql`SELECT id FROM active_tenant_ids() AS id`,
    );
    let checked = 0;
    for (const { id: tenantId } of tenants.rows) {
      const candidates = await withTenantTransaction(this.database.db, { tenantId }, (tx) =>
        this.candidates(tx),
      ).catch((error: unknown) => {
        this.logger.warn({ msg: 'channel-watch', tenantId, code: errorCode(error) });
        return [];
      });
      for (const channel of candidates) {
        checked++;
        const result = await this.check(tenantId, channel).catch((error: unknown) => {
          this.logger.warn({ msg: 'channel-watch', channelId: channel.id, code: errorCode(error) });
          return null;
        });
        if (result && result !== 'arrancando') {
          this.logger.log({ msg: 'channel-watch', channelId: channel.id, result });
        }
      }
    }
    return checked;
  }

  async check(tenantId: string, channel: WatchedChannel): Promise<WatchResult> {
    const provider = this.providers.get(channel.provider as WhatsAppProviderId);
    if (!provider || provider.capabilities.pairing !== 'qr') return 'sin_cambios';
    const state = await provider.getSessionState(channel.externalId);
    switch (state.state) {
      case 'connected': {
        const event: SessionStatusEvent = {
          type: 'session.status',
          provider: provider.id,
          channelExternalId: channel.externalId,
          eventId: `channel-watch:${randomUUID()}`,
          status: 'connected',
          phoneNumber: state.phoneNumber,
          failed: false,
        };
        const result = await this.inbound.process(event, { channelId: channel.id, tenantId });
        return result === 'actualizado' ? 'conectado' : 'sin_cambios';
      }
      case 'stopped': {
        const resumed = await provider.resumeSession(channel.externalId);
        if (!resumed.ok) {
          this.logger.warn({ msg: 'channel-watch', channelId: channel.id, code: resumed.code });
          return 'proveedor_no_disponible';
        }
        return 'reiniciado';
      }
      case 'needs_scan':
        return (await this.markNeedsScan(tenantId, channel)) ? 'requiere_qr' : 'sin_cambios';
      case 'starting':
        return 'arrancando';
      case 'unavailable':
        return 'proveedor_no_disponible';
    }
  }

  /**
   * Con número y sin conectar: "Reconectando" (pending) o desconectado sin motivo (se cayó la conexión). Sin
   * pausa de envíos vigente. Los pending que esperan un escaneo pedido desde el panel se descartan.
   */
  private async candidates(tx: AppTx): Promise<WatchedChannel[]> {
    const rows = await tx
      .select({
        id: channels.id,
        provider: channels.provider,
        externalId: channels.externalId,
        status: channels.status,
      })
      .from(channels)
      .where(
        and(
          isNotNull(channels.externalId),
          isNotNull(channels.phoneNumber),
          or(
            eq(channels.status, 'pending'),
            and(eq(channels.status, 'disconnected'), isNull(channels.disconnectReason)),
          ),
          or(isNull(channels.sendingPausedUntil), sql`${channels.sendingPausedUntil} <= now()`),
        ),
      );
    const result: WatchedChannel[] = [];
    for (const row of rows) {
      if (row.status === 'pending' && (await waitingForScan(tx, row.id))) continue;
      result.push({ ...row, externalId: row.externalId! });
    }
    return result;
  }

  /**
   * El teléfono ya no está vinculado: desconectado con session_failed ("Volvé a vincular el número"), así no
   * se vuelve a intentar. Se revisa de nuevo con el canal bloqueado por si mientras tanto alguien pidió un QR
   * o el canal cambió. No se detiene la sesión: si alguien pide reconectar justo ahora, no se le corta el QR
   * (WAHA la da por fallada sola cuando se agotan los QR).
   */
  private markNeedsScan(tenantId: string, channel: WatchedChannel): Promise<boolean> {
    return withTenantTransaction(this.database.db, { tenantId }, async (tx) => {
      const [current] = await tx
        .select({ status: channels.status, disconnectReason: channels.disconnectReason })
        .from(channels)
        .where(eq(channels.id, channel.id))
        .for('update');
      if (!current || current.status !== channel.status) return false;
      if (current.status === 'disconnected' && current.disconnectReason !== null) return false;
      if (current.status === 'pending' && (await waitingForScan(tx, channel.id))) return false;
      await tx
        .update(channels)
        .set({
          status: 'disconnected',
          disconnectedAt: sql`coalesce(${channels.disconnectedAt}, now())`,
          disconnectReason: 'session_failed',
        })
        .where(eq(channels.id, channel.id));
      await publishNotice(tx, { kind: 'channel', type: 'channel.updated', tenantId, channelId: channel.id });
      return true;
    });
  }
}

/** Lo último del canal fue el alta o un pedido de QR nuevo: una persona está por escanear. */
async function waitingForScan(tx: AppTx, channelId: string): Promise<boolean> {
  const [last] = await tx
    .select({ type: channelEvents.type })
    .from(channelEvents)
    .where(
      and(
        eq(channelEvents.channelId, channelId),
        inArray(channelEvents.type, ['created', 'reconnect_requested', 'connected']),
      ),
    )
    .orderBy(desc(channelEvents.createdAt), desc(channelEvents.id))
    .limit(1);
  return last?.type === 'created' || last?.type === 'reconnect_requested';
}
