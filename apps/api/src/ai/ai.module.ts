import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { OutboundModule } from '../messaging/outbound/outbound.module.js';
import { TenantConfigService } from './config/tenant-config.service.js';
import { AI_BUDGET_GUARD, NoopBudgetGuard } from './llm/budget-guard.js';
import { LLM_CLIENT_FACTORY, PlatformLlmClientFactory } from './llm/llm-client.factory.js';
import { AiReplyService } from './reply/ai-reply.service.js';
import { AiReplyWorker } from './reply/ai-reply.worker.js';

/**
 * Agente de IA (tarea 006): configuración por empresa, cliente de modelos y worker de ai-reply. La tarea
 * 008 reemplaza AI_BUDGET_GUARD y la 009 el LLM_CLIENT_FACTORY, sin tocar el pipeline.
 */
@Module({
  imports: [OutboundModule, CatalogModule],
  providers: [
    TenantConfigService,
    { provide: LLM_CLIENT_FACTORY, useClass: PlatformLlmClientFactory },
    { provide: AI_BUDGET_GUARD, useClass: NoopBudgetGuard },
    AiReplyService,
    AiReplyWorker,
  ],
  exports: [TenantConfigService],
})
export class AiModule {}
