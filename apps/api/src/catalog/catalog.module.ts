import { Module } from '@nestjs/common';
import { TenantConfigService } from '../ai/config/tenant-config.service.js';
import { CatalogRefreshWorker } from './catalog-refresh.worker.js';
import { CatalogService } from './catalog.service.js';

/** Catálogo (tarea 007): herramientas del agente, lectura de páginas y refresco de fondo. */
@Module({
  providers: [CatalogService, CatalogRefreshWorker, TenantConfigService],
  exports: [CatalogService, CatalogRefreshWorker],
})
export class CatalogModule {}
