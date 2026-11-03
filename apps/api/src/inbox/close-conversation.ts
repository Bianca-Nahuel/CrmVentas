import { sql } from 'drizzle-orm';
import type { AppTx } from '../db/tenant-context.js';
import { supersedeQueuedAiReplies } from '../messaging/outbound/outbound.service.js';
import { refreshConversationMetrics } from '../performance/conversation-metrics.js';
import { publishConversationEvent } from '../realtime/publish.js';
import type { CloseOutcome } from './inbox.contracts.js';

/**
 * Cierra una conversación ya bloqueada (FOR UPDATE) y abierta: resultado, evento, métricas, tiempo real y
 * las respuestas de la IA que esperaban en el outbox. Las que el worker ai-reply todavía no encoló las
 * descarta él mismo: su filtro (T1 y T2, con la misma fila bloqueada) corta si status <> 'open'.
 * La usan el endpoint (con usuario) y el cierre automático (sin usuario, auto_inactive).
 */
export async function closeLockedConversation(
  tx: AppTx,
  target: { tenantId: string; conversationId: string; channelId: string },
  close: {
    outcome: CloseOutcome | 'auto_inactive';
    note: string | null;
    userId: string | null;
    // Solo con 'sold' (el contrato y el CHECK de 0030 lo exigen).
    amount?: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE conversations
    SET status = 'closed', closed_at = now(), close_outcome = ${close.outcome}, closed_by = ${close.userId},
        close_note = ${close.note}, close_amount = ${close.amount ?? null}::numeric
    WHERE id = ${target.conversationId}
  `);
  const superseded = await supersedeQueuedAiReplies(tx, target.conversationId);
  // Sin la nota (texto libre del equipo): el resultado y cuántas respuestas de la IA se cancelaron.
  const data = { outcome: close.outcome, superseded_ai_replies: superseded };
  await tx.execute(sql`
    INSERT INTO conversation_events (tenant_id, conversation_id, type, user_id, data, created_at)
    VALUES (app_tenant_id(), ${target.conversationId}, 'closed', ${close.userId}, ${JSON.stringify(data)}::jsonb,
            clock_timestamp())
  `);
  await refreshConversationMetrics(tx, target.conversationId);
  await publishConversationEvent(tx, 'conversation.updated', target);
}
