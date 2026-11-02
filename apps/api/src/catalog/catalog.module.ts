import { Module } from '@nestjs/common';
import { TenantConfigService } from '../ai/config/tenant-config.service.js';
import { CatalogAdminController } from './catalog-admin.controller.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import { CatalogRefreshWorker } from './catalog-refresh.worker.js';
import { CatalogService } from './catalog.service.js';
import { ImportFilesPurgeWorker } from './import-files-purge.worker.js';

/**
 * Catálogo (tarea 007): herramientas del agente, lectura de páginas y refresco de fondo. Panel de catálogo
 * (tarea 027): importar el Excel, ver los productos y probar el extractor.
 */
@Module({
  controllers: [CatalogAdminController],
  providers: [
    CatalogService,
    CatalogRefreshWorker,
    TenantConfigService,
    CatalogAdminService,
    ImportFilesPurgeWorker,
  ],
  exports: [CatalogService, CatalogRefreshWorker],
})
export class CatalogModule {}
