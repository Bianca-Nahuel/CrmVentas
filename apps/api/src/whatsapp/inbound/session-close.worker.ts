import { Inject, Injectable, Logger, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import type { WhatsAppProviderId } from '@ventas/shared';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { APP_DB, type AppDatabase } from '../../db/database.module.js';
import { channels } from '../../db/schema/messaging.js';
import { withTenantTransaction } from '../../db/tenant-context.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { BOSS, pollingSeconds, QUEUES } from '../../jobs/jobs.module.js';
import { WHATSAPP_PROVIDER_REGISTRY, type WhatsAppProviderRegistry } from '../provider.js';
import type { SessionCloseJob } from './session-close.job.js';

const WORK_OPTIONS = { localConcurrency: 1 } as const;
type WorkOptions = typeof WORK_OPTIONS & { pollingIntervalSeconds: number };
const REJECTED = new Set(['phone_mismatch', 'number_in_use']);

// Worker de whatsapp-session-close. Desvincula la sesión de un escaneo rechazado; si mientras tanto
// alguien pidió reconectar el canal (el motivo ya no es un rechazo), no hace nada. Un error del
// proveedor se lanza para que pg-boss reintente. Logs: ids y resultado.
@Injectable()
export class SessionCloseWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger('SessionCloseWorker');
  // Inyección por propiedad: los tests que crean el worker a mano no la pasan (queda el valor por defecto).
  @Optional() @Inject(ENV) private readonly env?: Env;

  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(APP_DB) private readonly database: AppDatabase,
    @Inject(WHATSAPP_PROVIDER_REGISTRY) private readonly providers: WhatsAppProviderRegistry,
  ) {}

  private workOptions(): WorkOptions {
    return { ...WORK_OPTIONS, pollingIntervalSeconds: pollingSeconds(this.env, 2) };
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work<SessionCloseJob>(QUEUES.whatsappSessionClose, this.workOptions(), async (jobs) => {
      for (const job of jobs) await this.handle(job.data);
    });
  }

  async handle(job: SessionCloseJob): Promise<'cerrada' | 'sin_cambios'> {
    const [channel] = await withTenantTransaction(this.database.db, { tenantId: job.tenantId }, (tx) =>
      tx
        .select({
          provider: channels.provider,
          externalId: channels.externalId,
          reason: channels.disconnectReason,
        })
        .from(channels)
        .where(eq(channels.id, job.channelId)),
    );
    const provider = channel ? this.providers.get(channel.provider as WhatsAppProviderId) : undefined;
    if (!channel?.externalId || !provider || !REJECTED.has(channel.reason ?? '')) {
      this.logger.log({ msg: 'session-close', channelId: job.channelId, result: 'sin_cambios' });
      return 'sin_cambios';
    }
    const closed = await provider.closeSession(channel.externalId, { forget: false });
    if (!closed.ok) {
      this.logger.warn({
        msg: 'session-close',
        channelId: job.channelId,
        code: closed.code,
        result: 'reintento',
      });
      throw new Error(`No se pudo cerrar la sesión (código ${closed.code})`);
    }
    this.logger.log({ msg: 'session-close', channelId: job.channelId, result: 'cerrada' });
    return 'cerrada';
  }
}
