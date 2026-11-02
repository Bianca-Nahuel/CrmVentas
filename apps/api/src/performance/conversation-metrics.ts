// Métricas por conversación (tarea 026). Una función y no un servicio: la llaman, dentro de su propia
// transacción, el worker de entrada (entrantes y ecos), el de salida (mensajes enviados), el de la IA (al
// derivar), el cierre y el backfill. Recalcula todo desde messages y conversations (idempotente), así un
// orden distinto de los trabajos no deja la fila desfasada.
import { tenantConfigSchema, type TenantConfig } from '@ventas/shared';
import { sql } from 'drizzle-orm';
import { businessSecondsBetween } from '../ai/reply/business-hours.js';
import { tierFor, type LeadTier } from '../ai/scoring/score.js';
import type { AppTx } from '../db/tenant-context.js';

export type Attribution = 'panel' | 'single_seller' | 'none';

type Row = {
  tenant_id: string;
  channel_id: string;
  created_at: Date;
  conversation_handed_off_at: Date | null;
  lead_score_peak: number | null;
  closed_at: Date | null;
  close_outcome: string | null;
  timezone: string;
  config: unknown;
  prev_handed_off_at: Date | null;
  prev_first_human_reply_at: Date | null;
  prev_attribution: Attribution | null;
  prev_attributed_user_id: string | null;
  first_inbound_at: Date | null;
  first_human_reply_at: Date | null;
  first_human_after_handoff_at: Date | null;
  inbound_count: number;
  human_count: number;
  ai_count: number;
  human_user_ids: string[];
  human_without_user: boolean;
  human_reply_weeks: string[];
  single_seller_id: string | null;
};

/** Nivel máximo: lead_score_peak con los umbrales de la config (el mismo criterio que lead_tier). */
function peakTier(score: number | null, config: TenantConfig | null): LeadTier | null {
  return score === null || !config ? null : tierFor(score, config.scoring.thresholds);
}

/**
 * A quién se le atribuyen las respuestas humanas (docs/decisiones.md, "Atribución por vendedor"):
 * 1. todas desde el panel por la misma persona → panel;
 * 2. si no, lo que se decidió con la primera respuesta humana (el número tenía un solo vendedor) se
 *    mantiene: es la foto de "esa semana";
 * 3. con la primera respuesta humana, si el número tiene un solo vendedor activo → single_seller.
 */
export function attributionFor(row: {
  humanCount: number;
  humanUserIds: string[];
  humanWithoutUser: boolean;
  prevAttribution: Attribution | null;
  prevAttributedUserId: string | null;
  prevFirstHumanReplyAt: Date | null;
  singleSellerId: string | null;
}): { attribution: Attribution; userId: string | null } {
  if (row.humanCount === 0) return { attribution: 'none', userId: null };
  if (row.humanUserIds.length === 1 && !row.humanWithoutUser) {
    return { attribution: 'panel', userId: row.humanUserIds[0]! };
  }
  if (row.prevAttribution === 'single_seller' && row.prevAttributedUserId) {
    return { attribution: 'single_seller', userId: row.prevAttributedUserId };
  }
  if (row.prevFirstHumanReplyAt === null && row.singleSellerId) {
    return { attribution: 'single_seller', userId: row.singleSellerId };
  }
  return { attribution: 'none', userId: null };
}

export async function refreshConversationMetrics(tx: AppTx, conversationId: string): Promise<void> {
  const result = await tx.execute<Row>(sql`
    SELECT c.tenant_id, c.channel_id, c.created_at, c.handed_off_at AS conversation_handed_off_at,
      c.lead_score_peak, c.closed_at, c.close_outcome, t.timezone,
      (SELECT tc.config FROM tenant_configs tc WHERE tc.tenant_id = c.tenant_id
        ORDER BY tc.version DESC LIMIT 1) AS config,
      prev.handed_off_at AS prev_handed_off_at, prev.first_human_reply_at AS prev_first_human_reply_at,
      prev.attribution AS prev_attribution, prev.attributed_user_id AS prev_attributed_user_id,
      m.first_inbound_at, m.first_human_reply_at, m.first_human_after_handoff_at,
      m.inbound_count, m.human_count, m.ai_count, m.human_user_ids, m.human_without_user, m.human_reply_weeks,
      (SELECT min(cm.user_id::text)::uuid FROM channel_members cm
        JOIN memberships ms ON ms.tenant_id = cm.tenant_id AND ms.user_id = cm.user_id
        WHERE cm.channel_id = c.channel_id AND ms.status = 'active' AND ms.role = 'seller'
        HAVING count(*) = 1) AS single_seller_id
    FROM conversations c
    JOIN tenants t ON t.id = c.tenant_id
    LEFT JOIN conversation_metrics prev ON prev.conversation_id = c.id
    CROSS JOIN LATERAL (
      SELECT
        min(x.sent_at) FILTER (WHERE x.sender_type = 'contact') AS first_inbound_at,
        min(x.sent_at) FILTER (WHERE x.sender_type = 'user') AS first_human_reply_at,
        min(x.sent_at) FILTER (
          WHERE x.sender_type = 'user' AND x.sent_at >= COALESCE(prev.handed_off_at, c.handed_off_at)
        ) AS first_human_after_handoff_at,
        count(*) FILTER (WHERE x.sender_type = 'contact')::int AS inbound_count,
        count(*) FILTER (WHERE x.sender_type = 'user')::int AS human_count,
        count(*) FILTER (WHERE x.sender_type = 'ai')::int AS ai_count,
        COALESCE(array_agg(DISTINCT x.sent_by_user_id) FILTER (
          WHERE x.sender_type = 'user' AND x.sent_by_user_id IS NOT NULL), '{}') AS human_user_ids,
        COALESCE(bool_or(x.sender_type = 'user' AND x.sent_by_user_id IS NULL), false) AS human_without_user,
        COALESCE(array_agg(DISTINCT to_char(date_trunc('week', x.sent_at AT TIME ZONE t.timezone), 'YYYY-MM-DD'))
          FILTER (WHERE x.sender_type = 'user'), '{}') AS human_reply_weeks
      FROM messages x WHERE x.conversation_id = c.id
    ) m
    WHERE c.id = ${conversationId}
  `);
  const row = result.rows[0];
  if (!row) return;

  const parsed = tenantConfigSchema.safeParse(row.config);
  const config = parsed.success ? parsed.data : null;
  const hours = config?.business.service_hours;
  const seconds = (from: Date | null, to: Date | null) =>
    from && to && hours ? businessSecondsBetween(new Date(from), new Date(to), hours, row.timezone) : null;

  const handedOffAt = row.prev_handed_off_at ?? row.conversation_handed_off_at;
  // La primera respuesta se mide desde el primer mensaje del cliente: si una persona escribió antes (la
  // conversación la empezó el número), no hay tiempo de respuesta que medir.
  const firstHuman = row.first_human_reply_at;
  const firstInbound = row.first_inbound_at;
  const firstResponse =
    firstInbound && firstHuman && new Date(firstHuman) >= new Date(firstInbound)
      ? seconds(firstInbound, firstHuman)
      : null;
  const afterHandoff = handedOffAt ? row.first_human_after_handoff_at : null;
  const { attribution, userId } = attributionFor({
    humanCount: row.human_count,
    humanUserIds: row.human_user_ids,
    humanWithoutUser: row.human_without_user,
    prevAttribution: row.prev_attribution,
    prevAttributedUserId: row.prev_attributed_user_id,
    prevFirstHumanReplyAt: row.prev_first_human_reply_at,
    singleSellerId: row.single_seller_id,
  });

  const values = {
    openedAt: row.created_at,
    firstInboundAt: firstInbound,
    firstHumanReplyAt: firstHuman,
    handedOffAt,
    afterHandoff,
    firstResponse,
    handoffResponse: seconds(handedOffAt, afterHandoff),
    tier: peakTier(row.lead_score_peak, config),
  };
  await tx.execute(sql`
    INSERT INTO conversation_metrics (conversation_id, tenant_id, channel_id, opened_at, first_inbound_at,
      first_human_reply_at, handed_off_at, first_human_reply_after_handoff_at, first_response_seconds_business,
      handoff_response_seconds_business, human_messages_count, ai_messages_count, inbound_count,
      human_participated, human_reply_weeks, unanswered, lead_tier_peak, closed_at, close_outcome,
      attributed_user_id, attribution)
    VALUES (${conversationId}, ${row.tenant_id}, ${row.channel_id}, ${values.openedAt}, ${values.firstInboundAt},
      ${values.firstHumanReplyAt}, ${values.handedOffAt}, ${values.afterHandoff}, ${values.firstResponse},
      ${values.handoffResponse}, ${row.human_count}, ${row.ai_count}, ${row.inbound_count},
      ${row.human_count > 0}, ${sql.param(row.human_reply_weeks)}::date[], ${handedOffAt !== null && values.afterHandoff === null},
      ${values.tier},
      ${row.closed_at}, ${row.close_outcome}, ${userId}, ${attribution})
    ON CONFLICT (conversation_id) DO UPDATE SET
      opened_at = excluded.opened_at,
      first_inbound_at = excluded.first_inbound_at,
      first_human_reply_at = excluded.first_human_reply_at,
      handed_off_at = excluded.handed_off_at,
      first_human_reply_after_handoff_at = excluded.first_human_reply_after_handoff_at,
      first_response_seconds_business = excluded.first_response_seconds_business,
      handoff_response_seconds_business = excluded.handoff_response_seconds_business,
      human_messages_count = excluded.human_messages_count,
      ai_messages_count = excluded.ai_messages_count,
      inbound_count = excluded.inbound_count,
      human_participated = excluded.human_participated,
      human_reply_weeks = excluded.human_reply_weeks,
      unanswered = excluded.unanswered,
      lead_tier_peak = excluded.lead_tier_peak,
      closed_at = excluded.closed_at,
      close_outcome = excluded.close_outcome,
      attributed_user_id = excluded.attributed_user_id,
      attribution = excluded.attribution
  `);
}
