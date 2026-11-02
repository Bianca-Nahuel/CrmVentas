// Trabajo diario de la tarea 026. pg-boss corre sin su programador (schedule: false), así que cada instancia
// de la API encola performance-daily al arrancar y cada hora con singletonSeconds de un día: el índice de
// pg-boss descarta los repetidos y queda uno por día para todo el sistema. Ese trabajo reparte uno por
// empresa en performance-tenant (cierre automático, revisiones y resumen semanal), que se reintenta solo.
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { APP_DB, type AppDatabase } from '../db/database.module.js';
import { errorCode } from '../jobs/error-code.js';
import { BOSS, QUEUES } from '../jobs/jobs.module.js';
import { AutoCloseService } from './auto-close.service.js';
import { ReviewService } from './review/review.service.js';

export interface PerformanceTenantJob {
  tenantId: string;
}

const DAY_SECONDS = 86_400;
const SCHEDULE_EVERY_MS = 60 * 60 * 1000;

@Injectable()
export class PerformanceDailyWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PerformanceDaily');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(APP_DB) private readonly database: AppDatabase,
    private readonly autoClose: AutoCloseService,
    private readonly reviews: ReviewService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.PERFORMANCE_DAILY_ENABLED) return;
    await this.boss.work(QUEUES.performanceDaily, { localConcurrency: 1 }, async () => {
      await this.dispatch();
    });
    await this.boss.work<PerformanceTenantJob>(
      QUEUES.performanceTenant,
      { localConcurrency: 1 },
      async (jobs) => {
        for (const job of jobs) await this.runTenant(job.data.tenantId);
      },
    );
    await this.schedule();
    this.timer = setInterval(() => void this.schedule(), SCHEDULE_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async schedule(): Promise<void> {
    try {
      await this.boss.send(QUEUES.performanceDaily, {}, { singletonSeconds: DAY_SECONDS });
    } catch (error) {
      this.logger.warn({ msg: 'performance-daily: no se pudo encolar', code: errorCode(error) });
    }
  }

  /** Un trabajo por empresa activa (solo el id). */
  async dispatch(): Promise<number> {
    const tenants = await this.database.db.execute<{ id: string }>(
      sql`SELECT id FROM active_tenant_ids() AS id`,
    );
    for (const { id } of tenants.rows) {
      await this.boss.send(QUEUES.performanceTenant, { tenantId: id } satisfies PerformanceTenantJob, {
        singletonKey: id,
      });
    }
    this.logger.log({ msg: 'performance-daily', tenants: tenants.rows.length });
    return tenants.rows.length;
  }

  /** Cada paso por separado: si falla uno, los otros corren igual. */
  async runTenant(tenantId: string): Promise<void> {
    const closed = await this.autoClose.run(tenantId).catch((error: unknown) => {
      this.logger.warn({ msg: 'auto-close', tenantId, code: errorCode(error) });
      return null;
    });
    const reviewed = await this.reviews.runForTenant(tenantId).catch((error: unknown) => {
      this.logger.warn({ msg: 'review', tenantId, code: errorCode(error) });
      return null;
    });
    const digests = await this.reviews.runWeeklyDigests(tenantId).catch((error: unknown) => {
      this.logger.warn({ msg: 'review-digest', tenantId, code: errorCode(error) });
      return null;
    });
    this.logger.log({
      msg: 'performance-tenant',
      tenantId,
      closed: closed?.closed ?? null,
      reviewed: reviewed?.reviewed ?? null,
      digests: digests?.created ?? null,
    });
  }
}
