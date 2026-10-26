import { Module } from '@nestjs/common';
import { WhatsappModule } from '../../whatsapp/whatsapp.module.js';
import { OutboundService } from './outbound.service.js';
import { OutboundWorker } from './outbound.worker.js';
import { PresenceService } from './presence.service.js';

/**
 * Envío de mensajes: OutboundService (encolar, con las reglas), el worker de whatsapp-outbound y
 * PresenceService (visto + escribiendo antes de tener el texto, para la IA).
 */
@Module({
  imports: [WhatsappModule],
  providers: [OutboundService, OutboundWorker, PresenceService],
  exports: [OutboundService, PresenceService],
})
export class OutboundModule {}
