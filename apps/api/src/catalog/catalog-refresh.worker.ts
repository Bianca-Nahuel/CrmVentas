// Refresco de fondo de precios (tarea 007): por empresa, los productos más consultados de la semana cuyo
// precio de la web vence dentro de la próxima hora. Lo encola el worker de la IA (como mucho uno esperando
// por empresa, una hora después) cuando un turno consultó el catálogo; sin consultas, no corre.
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { TenantConfigService } from '../ai/config/tenant-config.service.js';
import { APP_DB, type AppDatabase } from '../db/database.module.js';
import { withTenantTransaction } from '../db/tenant-context.js';
import { errorCode } from '../jobs/error-code.js';
import { BOSS, QUEUES } from '../jobs/jobs.module.js';
import { CatalogService } from './catalog.service.js';

export interface CatalogRefreshJob {
  tenantId: string;
}

/** Cuándo corre el refresco después del turno que lo pidió. */
export const CATALOG_REFRESH_DELAY_SECONDS = 3_600;

@Injectable()
export class CatalogRefreshWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger('CatalogRefresh');

  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(APP_DB) private readonly database: AppDatabase,
    private readonly configs: TenantConfigService,
    private readonly catalog: CatalogService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work<CatalogRefreshJob>(QUEUES.catalogRefresh, { localConcurrency: 1 }, async (jobs) => {
      for (const job of jobs) await this.refresh(job.data.tenantId);
    });
  }

  /** Encola el refresco de la empresa (si ya hay uno esperando, pg-boss lo descarta: policy stately). */
  async schedule(tenantId: string): Promise<void> {
    await this.boss.send(QUEUES.catalogRefresh, { tenantId } satisfies CatalogRefreshJob, {
      singletonKey: tenantId,
      startAfter: CATALOG_REFRESH_DELAY_SECONDS,
    });
  }

  async refresh(tenantId: string): Promise<{ refreshed: number }> {
    const plan = await withTenantTransaction(this.database.db, { tenantId }, async (tx) => {
      const loaded = await this.configs.latest(tx);
      if (loaded.kind !== 'ok') return null;
      const catalog = loaded.config.catalog;
      if (!catalog?.enabled || !catalog.refresh.enabled || catalog.price_source === 'excel') return null;
      // Más consultados en 7 días (por ai_runs), con un precio de la web que vence en la próxima hora.
      const result = await tx.execute<{ sku: string }>(sql`
        WITH consulted AS (
          SELECT c ->> 'sku' AS sku, count(*) AS n
          FROM ai_runs r, jsonb_array_elements(r.catalog_citations -> 'consulted') c
          WHERE r.created_at > now() - interval '7 days' AND r.catalog_citations IS NOT NULL
          GROUP BY 1
        )
        SELECT p.sku FROM consulted k
        JOIN catalog_products p ON p.sku = k.sku AND p.active AND p.url IS NOT NULL
        LEFT JOIN LATERAL (
          SELECT s.read_at FROM product_snapshots s
          WHERE s.product_id = p.id AND s.source = 'web' AND s.ok ORDER BY s.read_at DESC LIMIT 1
        ) last ON true
        WHERE last.read_at IS NULL
           OR last.read_at < now() - make_interval(mins => ${catalog.max_price_age_minutes}) + interval '1 hour'
        ORDER BY k.n DESC, p.sku
        LIMIT ${catalog.refresh.top_n}
      `);
      return { catalog, skus: result.rows.map((row) => row.sku) };
    });
    if (!plan) return { refreshed: 0 };
    const store = this.catalog.store(tenantId);
    let refreshed = 0;
    for (const sku of plan.skus) {
      try {
        const product = await store.findProduct(sku);
        if (!product) continue;
        const result = await this.catalog.reader.read(store, plan.catalog, product, { force: true });
        if (result.fetched && !result.errorCode) refreshed++;
      } catch (error) {
        this.logger.warn({ msg: 'catalog-refresh', tenantId, code: errorCode(error) });
      }
    }
    this.logger.log({ msg: 'catalog-refresh', tenantId, candidates: plan.skus.length, refreshed });
    return { refreshed };
  }
}
