import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ChannelsService } from './channels.service.js';
import { ConversationScope } from './conversation-scope.js';
import { ChannelsController, InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';

/**
 * Bandeja y leads (tarea 014): grilla, conversación de solo lectura, reactivar la IA y asignar números a
 * vendedores. ConversationScope se exporta para el envío (024) y el tiempo real (025).
 */
@Module({
  imports: [AiModule],
  controllers: [InboxController, ChannelsController],
  providers: [ConversationScope, InboxService, ChannelsService],
  exports: [ConversationScope],
})
export class InboxModule {}
