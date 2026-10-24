import { Module } from '@nestjs/common';
import { WhatsappModule } from '../../whatsapp/whatsapp.module.js';
import { OutboundService } from './outbound.service.js';
import { OutboundWorker } from './outbound.worker.js';

/** Envío de mensajes: OutboundService (encolar, con las reglas) y el worker de whatsapp-outbound. */
@Module({
  imports: [WhatsappModule],
  providers: [OutboundService, OutboundWorker],
  exports: [OutboundService],
})
export class OutboundModule {}
