import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AppTx, TenantContext } from '../db/tenant-context.js';
import { closeLockedConversation } from './close-conversation.js';
import { ConversationScope, scopeCondition } from './conversation-scope.js';
import type { CloseConversationBody, ConversationDetail } from './inbox.contracts.js';
import { InboxService } from './inbox.service.js';

/** Cierre manual desde el panel (tarea 026). */
@Injectable()
export class CloseService {
  constructor(
    private readonly scopes: ConversationScope,
    private readonly inbox: InboxService,
  ) {}

  /** Idempotente: cerrar una ya cerrada devuelve el detalle sin cambios. Ajena o inexistente → 404. */
  async close(
    tx: AppTx,
    context: TenantContext,
    id: string,
    body: CloseConversationBody,
  ): Promise<ConversationDetail> {
    const scope = await this.scopes.resolve(tx, context);
    const result = await tx.execute<{ channel_id: string; status: string }>(sql`
      SELECT c.channel_id, c.status FROM conversations c
      WHERE c.id = ${id} AND ${scopeCondition(scope, sql`c.channel_id`)}
      FOR UPDATE
    `);
    const row = result.rows[0];
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (row.status === 'open') {
      await closeLockedConversation(
        tx,
        { tenantId: context.tenantId, conversationId: id, channelId: row.channel_id },
        { outcome: body.outcome, note: body.note || null, userId: context.userId },
      );
    }
    return this.inbox.getConversation(tx, context, id);
  }
}
