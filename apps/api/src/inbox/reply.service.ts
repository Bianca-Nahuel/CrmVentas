import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AppTx, TenantContext } from '../db/tenant-context.js';
import {
  IdempotencyConflictError,
  OutboundService,
  pauseAiAfterHuman,
  supersedeQueuedAiReplies,
  type RejectReason,
} from '../messaging/outbound/outbound.service.js';
import { publishConversationEvent } from '../realtime/publish.js';
import { ConversationScope, scopeCondition } from './conversation-scope.js';
import type { MessageDto, SendMessageBody } from './inbox.contracts.js';
import { InboxService } from './inbox.service.js';

/** Código del 409 por cada regla de envío (el panel lo explica). */
const REJECT_CODES: Record<RejectReason, string> = {
  no_inbound: 'NO_INBOUND',
  window_expired: 'WINDOW_EXPIRED',
  contact_blocked: 'CONTACT_BLOCKED',
  channel_unavailable: 'CHANNEL_UNAVAILABLE',
  channel_paused: 'CHANNEL_PAUSED',
  superseded: 'SUPERSEDED',
};

/**
 * Responder por WhatsApp desde el panel (tarea 024). Pasa por el outbox como cualquier envío: mismas
 * reglas (solo conversaciones que inició el cliente, dentro de la ventana, con el canal conectado y sin
 * pausa) y el mismo worker (visto → escribiendo → enviar).
 */
@Injectable()
export class ReplyService {
  constructor(
    private readonly scopes: ConversationScope,
    private readonly outbound: OutboundService,
    private readonly inbox: InboxService,
  ) {}

  /**
   * Encola el texto y, en la misma transacción, pausa la IA y deja sin efecto sus respuestas en cola. La
   * conversación queda bloqueada (FOR UPDATE) como en la T2 de ai-reply: o la IA ya encoló su respuesta
   * (y acá se cancela si no salió) o, cuando bloquee, ve la pausa y no responde.
   * La misma idempotencyKey devuelve el envío de la primera vez, sin volver a pausar. Si una regla de
   * envío no se cumple, 409 con su código: la excepción hace rollback y no queda ninguna fila.
   */
  async send(tx: AppTx, context: TenantContext, id: string, input: SendMessageBody): Promise<MessageDto> {
    const scope = await this.scopes.resolve(tx, context);
    const visible = await tx.execute<{ channel_id: string }>(sql`
      SELECT c.channel_id FROM conversations c WHERE c.id = ${id} AND ${scopeCondition(scope, sql`c.channel_id`)}
      FOR UPDATE
    `);
    if (visible.rows.length === 0) throw new NotFoundException({ code: 'NOT_FOUND' });

    let result;
    try {
      result = await this.outbound.enqueueText(
        {
          conversationId: id,
          body: input.body,
          senderType: 'user',
          sentByUserId: context.userId,
          // Prefijo propio: nunca choca con las claves de la IA (ai:<messageId>).
          idempotencyKey: `panel:${input.idempotencyKey}`,
        },
        tx,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
      }
      throw error;
    }
    if (result.status === 'rejected') {
      throw new ConflictException({ code: REJECT_CODES[result.rejectReason ?? 'channel_unavailable'] });
    }
    if (result.created) {
      await pauseAiAfterHuman(tx, id);
      await supersedeQueuedAiReplies(tx, id);
      // La IA quedó pausada (el envío nuevo ya lo avisó enqueueText).
      await publishConversationEvent(tx, 'conversation.updated', {
        tenantId: context.tenantId,
        channelId: visible.rows[0]!.channel_id,
        conversationId: id,
      });
    }
    return this.inbox.outboundAsMessage(tx, id, result.outboundId);
  }
}
