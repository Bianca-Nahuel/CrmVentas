// Borra los .xlsx subidos desde el panel que ya vencieron (24 h, tarea 027). Mismo esquema que
// performance-daily: pg-boss corre sin su programador, así que cada instancia encola el trabajo al arrancar y
// cada hora con singletonSeconds de una hora; el índice de pg-boss descarta los repetidos. El borrado lo hace
// purge_expired_catalog_import_files() (0027): ventas_app no tiene DELETE sobre la tabla.
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { APP_DB, type AppDatabase } from '../db/database.module.js';
import { errorCode } from '../jobs/error-code.js';
import { BOSS, QUEUES } from '../jobs/jobs.module.js';

const HOUR_SECONDS = 3_600;

@Injectable()
export class ImportFilesPurgeWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ImportFilesPurge');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(APP_DB) private readonly database: AppDatabase,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.catalogImportFilesPurge, { localConcurrency: 1 }, async () => {
      await this.purge();
    });
    await this.schedule();
    this.timer = setInterval(() => void this.schedule(), HOUR_SECONDS * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async schedule(): Promise<void> {
    try {
      await this.boss.send(QUEUES.catalogImportFilesPurge, {}, { singletonSeconds: HOUR_SECONDS });
    } catch (error) {
      this.logger.warn({ msg: 'catalog-import-files-purge: no se pudo encolar', code: errorCode(error) });
    }
  }

  async purge(): Promise<number> {
    const result = await this.database.db.execute<{ deleted: number }>(
      sql`SELECT purge_expired_catalog_import_files() AS deleted`,
    );
    const deleted = result.rows[0]?.deleted ?? 0;
    this.logger.log({ msg: 'catalog-import-files-purge', deleted });
    return deleted;
  }
}
