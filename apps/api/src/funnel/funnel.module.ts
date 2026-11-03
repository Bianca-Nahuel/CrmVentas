import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module.js';
import { FunnelController } from './funnel.controller.js';
import { FunnelService } from './funnel.service.js';

/**
 * Embudo de ventas (tarea 028): etapas por cohorte desde conversation_metrics, sus listas de leads y los
 * estancados. Los datos los mantienen el worker de la IA (lead_tier_peak), el cierre (close_amount) y
 * refreshConversationMetrics; el relleno de lo viejo, src/funnel/funnel-backfill.ts.
 */
@Module({
  imports: [InboxModule],
  controllers: [FunnelController],
  providers: [FunnelService],
})
export class FunnelModule {}
