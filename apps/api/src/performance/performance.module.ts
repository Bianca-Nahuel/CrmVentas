import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AutoCloseService } from './auto-close.service.js';
import { PerformanceDailyWorker } from './performance-daily.worker.js';
import { PerformanceController } from './performance.controller.js';
import { PerformanceService } from './performance.service.js';
import { ReviewService } from './review/review.service.js';

/**
 * Revisión de vendedores (tarea 026): métricas semanales, analista de calidad y trabajo diario (cierre por
 * inactividad, revisiones y resumen semanal). Las métricas por conversación las recalculan los workers con
 * refreshConversationMetrics (conversation-metrics.ts), sin pasar por este módulo.
 */
@Module({
  imports: [AiModule],
  controllers: [PerformanceController],
  providers: [PerformanceService, AutoCloseService, ReviewService, PerformanceDailyWorker],
  exports: [ReviewService, AutoCloseService],
})
export class PerformanceModule {}
