// Relleno de los datos del embudo (tarea 028) para conversaciones que ya existían. Lo usan el script
// dev:backfill-funnel y los tests. Idempotente: el nivel solo se completa si está vacío, la primera derivación
// toma el mínimo de todo lo conocido y las métricas se recalculan desde cero.
import { sql } from 'drizzle-orm';
import { tierFor, type LeadTier } from '../ai/scoring/score.js';
import type { AppTx } from '../db/tenant-context.js';
import { refreshConversationMetrics } from '../performance/conversation-metrics.js';

const TIER_RANK: Record<LeadTier, number> = { cold: 0, warm: 1, hot: 2 };

type Thresholds = { hot: number; warm: number };

function thresholdsFrom(value: unknown): Thresholds | null {
  if (value === null || typeof value !== 'object') return null;
  const { hot, warm } = value as Record<string, unknown>;
  return typeof hot === 'number' && typeof warm === 'number' ? { hot, warm } : null;
}

/** El mayor de los niveles (null si no hay ninguno). */
export function highestTier(tiers: (LeadTier | null)[]): LeadTier | null {
  let best: LeadTier | null = null;
  for (const tier of tiers) if (tier && (!best || TIER_RANK[tier] > TIER_RANK[best])) best = tier;
  return best;
}

export interface FunnelBackfillResult {
  /** Se completó conversations.lead_tier_peak (estaba vacío). */
  tierFilled: boolean;
  /** La primera derivación de las métricas quedó antes de lo que tenía (o pasó a tenerla). */
  handoffMoved: boolean;
}

/**
 * Una conversación, dentro de la transacción de su empresa:
 * 1. lead_tier_peak, solo si es NULL: el máximo entre los niveles de cada corrida de la IA con puntaje (cada
 *    una con los umbrales de SU versión de la configuración, o la última anterior a la corrida) y lead_tier
 *    (el último nivel, que el worker calculó con los umbrales de ese momento). Sin ninguno de los dos,
 *    lead_score_peak con la configuración más reciente.
 * 2. Primera derivación (conversation_metrics.handed_off_at): la más antigua entre la que ya tenía, la primera
 *    corrida que derivó, la derivación previa de cada reactivación y la de conversations.
 * 3. Métricas recalculadas (tiempos, nivel copiado, monto).
 */
export async function backfillFunnelConversation(
  tx: AppTx,
  conversationId: string,
): Promise<FunnelBackfillResult> {
  const current = await tx.execute<{
    lead_tier_peak: LeadTier | null;
    lead_tier: LeadTier | null;
    lead_score_peak: number | null;
  }>(sql`
    SELECT lead_tier_peak, lead_tier, lead_score_peak FROM conversations WHERE id = ${conversationId} FOR UPDATE
  `);
  const conversation = current.rows[0];
  if (!conversation) return { tierFilled: false, handoffMoved: false };

  let tierFilled = false;
  if (conversation.lead_tier_peak === null) {
    const runs = await tx.execute<{ score: number; thresholds: unknown }>(sql`
      SELECT r.score,
        COALESCE(
          (SELECT tc.config->'scoring'->'thresholds' FROM tenant_configs tc
            WHERE tc.tenant_id = r.tenant_id AND tc.version = r.config_version),
          (SELECT tc.config->'scoring'->'thresholds' FROM tenant_configs tc
            WHERE tc.tenant_id = r.tenant_id AND tc.created_at <= r.created_at
            ORDER BY tc.version DESC LIMIT 1)
        ) AS thresholds
      FROM ai_runs r
      WHERE r.conversation_id = ${conversationId} AND r.score IS NOT NULL
    `);
    let tier = highestTier([
      ...runs.rows.map((run) => {
        const thresholds = thresholdsFrom(run.thresholds);
        return thresholds ? tierFor(run.score, thresholds) : null;
      }),
      conversation.lead_tier,
    ]);
    if (tier === null && conversation.lead_score_peak !== null) {
      const latest = await tx.execute<{ thresholds: unknown }>(sql`
        SELECT config->'scoring'->'thresholds' AS thresholds FROM tenant_configs
        ORDER BY version DESC LIMIT 1
      `);
      const thresholds = thresholdsFrom(latest.rows[0]?.thresholds);
      tier = thresholds ? tierFor(conversation.lead_score_peak, thresholds) : null;
    }
    if (tier !== null) {
      await tx.execute(sql`
        UPDATE conversations SET lead_tier_peak = ${tier}
        WHERE id = ${conversationId} AND lead_tier_peak IS NULL
      `);
      tierFilled = true;
    }
  }

  // La fila de métricas tiene que existir antes de corregir su primera derivación.
  await refreshConversationMetrics(tx, conversationId);
  const moved = await tx.execute<{ conversation_id: string }>(sql`
    WITH earliest AS (
      SELECT LEAST(
        (SELECT min(r.created_at) FROM ai_runs r
          WHERE r.conversation_id = ${conversationId} AND r.decision = 'handed_off'),
        (SELECT min((e.data->>'previous_handed_off_at')::timestamptz) FROM conversation_events e
          WHERE e.conversation_id = ${conversationId} AND e.type = 'ai_reactivated'
            AND jsonb_typeof(e.data->'previous_handed_off_at') = 'string'),
        (SELECT c.handed_off_at FROM conversations c WHERE c.id = ${conversationId})
      ) AS at
    )
    UPDATE conversation_metrics cm SET handed_off_at = earliest.at
    FROM earliest
    WHERE cm.conversation_id = ${conversationId} AND earliest.at IS NOT NULL
      AND (cm.handed_off_at IS NULL OR earliest.at < cm.handed_off_at)
    RETURNING cm.conversation_id
  `);
  const handoffMoved = moved.rows.length > 0;
  // Con la derivación corregida se recalculan los tiempos y "sin respuesta" (conserva handed_off_at).
  if (handoffMoved) await refreshConversationMetrics(tx, conversationId);
  return { tierFilled, handoffMoved };
}
