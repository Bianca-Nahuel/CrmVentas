import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../auth/decorators.js';
import { currentTenantContext, currentTx } from '../db/tenant-context.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { ChannelConnectionService } from './channel-connection.service.js';
import {
  channelParamsSchema,
  createChannelBodySchema,
  setChannelMembersSchema,
  type CreateChannelBody,
} from './channels.contracts.js';
import { ChannelsService } from './channels.service.js';
import { CloseService } from './close.service.js';
import {
  closeConversationBodySchema,
  conversationParamsSchema,
  leadListQuerySchema,
  messageListQuerySchema,
  sendMessageBodySchema,
  type CloseConversationBody,
  type LeadListQuery,
  type SendMessageBody,
} from './inbox.contracts.js';
import { InboxService } from './inbox.service.js';
import { ReplyService } from './reply.service.js';

// Rutas y esquemas: inbox.contracts.ts y channels.contracts.ts (de ahí sale también el OpenAPI).
// La visibilidad por número la aplica InboxService con ConversationScope; el rol, @RequirePermission.

const idParam = new ZodValidationPipe(conversationParamsSchema, { notFound: true });

@Controller()
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly replies: ReplyService,
    private readonly closer: CloseService,
  ) {}

  @RequirePermission({ lead: ['read'] })
  @Get('leads')
  listLeads(@Query(new ZodValidationPipe(leadListQuerySchema)) query: LeadListQuery) {
    return this.inbox.listLeads(currentTx(), currentTenantContext(), query);
  }

  @RequirePermission({ lead: ['read'] })
  @Get('leads/summary')
  summary() {
    return this.inbox.summary(currentTx(), currentTenantContext());
  }

  @RequirePermission({ conversation: ['read'] })
  @Get('conversations/:id')
  getConversation(@Param(idParam) params: { id: string }) {
    return this.inbox.getConversation(currentTx(), currentTenantContext(), params.id);
  }

  @RequirePermission({ conversation: ['read'] })
  @Get('conversations/:id/messages')
  listMessages(
    @Param(idParam) params: { id: string },
    @Query(new ZodValidationPipe(messageListQuerySchema)) query: { before?: string; limit: number },
  ) {
    return this.inbox.listMessages(currentTx(), currentTenantContext(), params.id, query);
  }

  @RequirePermission({ conversation: ['reply'] })
  @HttpCode(200)
  @Post('conversations/:id/messages')
  sendMessage(
    @Param(idParam) params: { id: string },
    @Body(new ZodValidationPipe(sendMessageBodySchema)) body: SendMessageBody,
  ) {
    return this.replies.send(currentTx(), currentTenantContext(), params.id, body);
  }

  @RequirePermission({ conversation: ['read'] })
  @HttpCode(204)
  @Post('conversations/:id/read')
  async markRead(@Param(idParam) params: { id: string }) {
    await this.inbox.markRead(currentTx(), currentTenantContext(), params.id);
  }

  @RequirePermission({ conversation: ['close'] })
  @HttpCode(200)
  @Post('conversations/:id/close')
  close(
    @Param(idParam) params: { id: string },
    @Body(new ZodValidationPipe(closeConversationBodySchema)) body: CloseConversationBody,
  ) {
    return this.closer.close(currentTx(), currentTenantContext(), params.id, body);
  }

  @RequirePermission({ conversation: ['reply'] })
  @HttpCode(200)
  @Post('conversations/:id/reactivate-ai')
  reactivateAi(@Param(idParam) params: { id: string }) {
    return this.inbox.reactivateAi(currentTx(), currentTenantContext(), params.id);
  }
}

const channelIdParam = new ZodValidationPipe(channelParamsSchema, { notFound: true });

// Conexión por QR (tarea 011): conectar, reconectar, ver el QR y levantar la pausa piden channel:connect;
// desconectar y cancelar, channel:disconnect (owner y admin en libs/shared). Otra empresa → 404 (RLS).
@Controller()
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly connection: ChannelConnectionService,
  ) {}

  @RequirePermission({ channel: ['read'] })
  @Get('channels')
  async list() {
    return { items: await this.channels.list(currentTx()) };
  }

  @RequirePermission({ channel: ['connect'] })
  @HttpCode(200)
  @Post('channels')
  create(@Body(new ZodValidationPipe(createChannelBodySchema)) body: CreateChannelBody) {
    return this.connection.create(currentTx(), currentTenantContext(), body);
  }

  @RequirePermission({ channel: ['disconnect'] })
  @HttpCode(204)
  @Delete('channels/:id')
  async cancel(@Param(channelIdParam) params: { id: string }) {
    await this.connection.cancel(currentTx(), currentTenantContext(), params.id);
  }

  // El QR permite vincular un teléfono a la sesión de la empresa: nunca se cachea ni se loguea.
  @RequirePermission({ channel: ['connect'] })
  @Header('Cache-Control', 'no-store')
  @Get('channels/:id/pairing')
  pairing(@Param(channelIdParam) params: { id: string }) {
    return this.connection.pairing(currentTx(), params.id);
  }

  @RequirePermission({ channel: ['connect'] })
  @HttpCode(200)
  @Post('channels/:id/reconnect')
  reconnect(@Param(channelIdParam) params: { id: string }) {
    return this.connection.reconnect(currentTx(), currentTenantContext(), params.id);
  }

  @RequirePermission({ channel: ['disconnect'] })
  @HttpCode(200)
  @Post('channels/:id/disconnect')
  disconnect(@Param(channelIdParam) params: { id: string }) {
    return this.connection.disconnect(currentTx(), currentTenantContext(), params.id);
  }

  @RequirePermission({ channel: ['connect'] })
  @HttpCode(200)
  @Post('channels/:id/resume-sending')
  resumeSending(@Param(channelIdParam) params: { id: string }) {
    return this.connection.resumeSending(currentTx(), currentTenantContext(), params.id);
  }

  @RequirePermission({ channel: ['assign'] })
  @Put('channels/:id/members')
  setMembers(
    @Param(channelIdParam) params: { id: string },
    @Body(new ZodValidationPipe(setChannelMembersSchema)) body: { userIds: string[] },
  ) {
    return this.channels.setMembers(currentTx(), currentTenantContext(), params.id, body.userIds);
  }

  @RequirePermission({ channel: ['assign'] })
  @Get('members/sellers')
  async sellers() {
    return { items: await this.channels.sellerOptions(currentTx()) };
  }
}
