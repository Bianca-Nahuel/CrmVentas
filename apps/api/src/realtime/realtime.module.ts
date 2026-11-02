import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module.js';
import { EventsController } from './events.controller.js';
import { RealtimeHub } from './realtime-hub.js';
import { RealtimeListener } from './realtime-listener.js';

/**
 * Tiempo real de la bandeja (tarea 025): LISTEN inbox_events (RealtimeListener) → streams SSE filtrados por
 * empresa y número (RealtimeHub) → GET /api/events. Los avisos se publican con publishNotice (publish.ts)
 * dentro de la transacción de cada cambio.
 */
@Module({
  imports: [InboxModule],
  controllers: [EventsController],
  providers: [RealtimeListener, RealtimeHub],
  exports: [RealtimeHub, RealtimeListener],
})
export class RealtimeModule {}
