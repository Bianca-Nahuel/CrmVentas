import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { OutboundModule } from '../messaging/outbound/outbound.module.js';
import { ChannelsService } from './channels.service.js';
import { ConversationScope } from './conversation-scope.js';
import { ChannelsController, InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';
import { ReplyService } from './reply.service.js';

/**
 * Bandeja y leads (tarea 014): grilla, conversación de solo lectura, reactivar la IA y asignar números a
 * vendedores; responder desde el panel (024). ConversationScope lo usa también el tiempo real (025).
 */
@Module({
  imports: [AiModule, OutboundModule],
  controllers: [InboxController, ChannelsController],
  providers: [ConversationScope, InboxService, ReplyService, ChannelsService],
  exports: [ConversationScope],
})
export class InboxModule {}
