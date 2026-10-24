import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp.module.js';
import { InboundService } from './inbound.service.js';
import { InboundWorker } from './inbound.worker.js';

/** Procesamiento de los eventos entrantes (worker de la cola whatsapp-inbound). */
@Module({
  imports: [WhatsappModule],
  providers: [InboundService, InboundWorker],
})
export class InboundModule {}
