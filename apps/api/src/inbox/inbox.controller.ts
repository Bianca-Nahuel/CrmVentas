import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../auth/decorators.js';
import { currentTenantContext, currentTx } from '../db/tenant-context.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { channelParamsSchema, setChannelMembersSchema } from './channels.contracts.js';
import { ChannelsService } from './channels.service.js';
import {
  conversationParamsSchema,
  leadListQuerySchema,
  messageListQuerySchema,
  type LeadListQuery,
} from './inbox.contracts.js';
import { InboxService } from './inbox.service.js';

// Rutas y esquemas: inbox.contracts.ts y channels.contracts.ts (de ahí sale también el OpenAPI).
// La visibilidad por número la aplica InboxService con ConversationScope; el rol, @RequirePermission.

const idParam = new ZodValidationPipe(conversationParamsSchema, { notFound: true });

@Controller()
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

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

  @RequirePermission({ conversation: ['read'] })
  @HttpCode(204)
  @Post('conversations/:id/read')
  async markRead(@Param(idParam) params: { id: string }) {
    await this.inbox.markRead(currentTx(), currentTenantContext(), params.id);
  }

  @RequirePermission({ conversation: ['reply'] })
  @HttpCode(200)
  @Post('conversations/:id/reactivate-ai')
  reactivateAi(@Param(idParam) params: { id: string }) {
    return this.inbox.reactivateAi(currentTx(), currentTenantContext(), params.id);
  }
}

@Controller()
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @RequirePermission({ channel: ['read'] })
  @Get('channels')
  async list() {
    return { items: await this.channels.list(currentTx()) };
  }

  @RequirePermission({ channel: ['assign'] })
  @Put('channels/:id/members')
  setMembers(
    @Param(new ZodValidationPipe(channelParamsSchema, { notFound: true })) params: { id: string },
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
