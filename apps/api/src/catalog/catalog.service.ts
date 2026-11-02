// Catálogo para el agente (tarea 007): arma, para un turno, las herramientas atadas a la empresa de la
// conversación. El lector de páginas (con su límite por dominio) es uno solo para toda la app.
import { Inject, Injectable } from '@nestjs/common';
import type { CatalogConfig } from '@ventas/shared';
import { APP_DB, type AppDatabase } from '../db/database.module.js';
import { buildCatalogTools } from '../ai/tools/catalog-tools.js';
import { TurnCatalogContext } from '../ai/tools/turn-catalog-context.js';
import type { LlmTool } from '../ai/llm/llm-client.js';
import { CatalogViewer } from './catalog-viewer.js';
import { PgCatalogStore } from './pg-catalog-store.js';
import { ReadOnlyCatalogStore } from './read-only-catalog-store.js';
import { ProductPageReader } from './web/product-page-reader.js';
import { SafeFetcher } from './web/safe-fetch.js';

/** Identifica al sistema ante la web de la empresa. */
export const CATALOG_USER_AGENT = 'VentasCatalogBot/1.0 (lectura de precios autorizada por la empresa)';

@Injectable()
export class CatalogService {
  // Un solo SafeFetcher (y su límite por dominio) para el agente, el refresco y el probador del panel.
  readonly fetcher = new SafeFetcher({ userAgent: CATALOG_USER_AGENT });
  readonly reader = new ProductPageReader(this.fetcher);
  readonly viewer = new CatalogViewer(this.reader);

  constructor(@Inject(APP_DB) private readonly database: AppDatabase) {}

  store(tenantId: string): PgCatalogStore {
    return new PgCatalogStore(this.database.db, tenantId);
  }

  /**
   * Herramientas de un turno. null si la empresa no tiene el catálogo activo. readOnly (playground del
   * panel, tarea 027): las lecturas nuevas de la web no se guardan en la base.
   */
  forTurn(
    tenantId: string,
    catalog: CatalogConfig | undefined,
    now: Date,
    timezone: string,
    options: { readOnly?: boolean } = {},
  ): { tools: LlmTool[]; context: TurnCatalogContext } | null {
    if (!catalog?.enabled) return null;
    const context = new TurnCatalogContext(catalog, now, timezone);
    const store = options.readOnly ? new ReadOnlyCatalogStore(this.store(tenantId)) : this.store(tenantId);
    return {
      tools: buildCatalogTools({ store, viewer: this.viewer, context }),
      context,
    };
  }
}
