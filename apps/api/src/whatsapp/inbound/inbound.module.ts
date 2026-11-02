import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp.module.js';
import { InboundService } from './inbound.service.js';
import { InboundWorker } from './inbound.worker.js';
import { SessionCloseWorker } from './session-close.worker.js';

/**
 * Procesamiento de los eventos entrantes (worker de la cola whatsapp-inbound) y desvinculación de los
 * escaneos rechazados (whatsapp-session-close).
 */
@Module({
  imports: [WhatsappModule],
  providers: [InboundService, InboundWorker, SessionCloseWorker],
})
export class InboundModule {}
