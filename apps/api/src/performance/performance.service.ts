import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { roleCan, type ReviewConfig } from '@ventas/shared';
import { sql, type SQL } from 'drizzle-orm';
import { TenantConfigService } from '../ai/config/tenant-config.service.js';
import { localTime } from '../ai/reply/business-hours.js';
import type { AppTx, TenantContext } from '../db/tenant-context.js';
import {
  PERFORMANCE_DEFAULT_WEEKS,
  PERFORMANCE_MAX_WEEKS,
  type ReviewDetail,
  type ReviewListQuery,
  type WeeklyQuery,
  type WeeklyResponse,
  type WeekMetrics,
} from './performance.contracts.js';
import type { IssueType, ReviewOutput } from './review/prompt-v1.js';

const iso = (column: SQL) => sql`to_json(${column}) #>> '{}'`;
const OUTCOMES = ['sold', 'not_sold', 'no_response', 'not_a_lead', 'other', 'auto_inactive'] as const;

const DAY_MS = 86_400_000;
const parseDay = (day: string) =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const formatDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Lunes de la semana de un día (AAAA-MM-DD). */
export function mondayOf(day: string): string {
  const ms = parseDay(day);
  return formatDay(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
}

/** Rango de semanas (lunes) pedido, con el valor por defecto y el tope. */
export function resolveWeeks(query: { from?: string; to?: string }, today: string): string[] {
  const to = mondayOf(query.to ?? today);
  const from = mondayOf(query.from ?? formatDay(parseDay(to) - (PERFORMANCE_DEFAULT_WEEKS - 1) * 7 * DAY_MS));
  const count = (parseDay(to) - parseDay(from)) / (7 * DAY_MS) + 1;
  if (count < 1 || count > PERFORMANCE_MAX_WEEKS) {
    throw new BadRequestException({ code: 'VALIDATION_ERROR', issues: [{ path: 'from' }, { path: 'to' }] });
  }
  return Array.from({ length: count }, (_, index) => formatDay(parseDay(from) + index * 7 * DAY_MS));
}

type MetricsRow = {
  week_start: string;
  grp: string;
  attended: number;
  unattributed: number;
  closed_total: number;
  new_total: number;
  new_hot: number;
  new_warm: number;
  new_cold: number;
  new_unrated: number;
  handed_off: number;
  handed_off_unanswered: number;
  p50: number | null;
  p90: number | null;
  responded: number;
  ai_only: number;
} & Record<`closed_${(typeof OUTCOMES)[number]}`, number>;

type QualityRow = {
  week_start: string;
  grp: string;
  reviews: number;
  satisfied: number;
  neutral: number;
  dissatisfied: number;
  unknown: number;
};
type CriteriaRow = { week_start: string; grp: string; key: string; average: number };

/**
 * Comienzo y fin del rango (lunes 00:00 de la primera semana y de la siguiente a la última, hora local) como
 * expresiones constantes: el planificador las evalúa una vez y no por fila.
 */
const rangeStart = (weeks: string[], timezone: string) =>
  sql`((${weeks[0]}::date)::timestamp AT TIME ZONE ${timezone})`;
const rangeEnd = (weeks: string[], timezone: string) =>
  sql`(((${weeks.at(-1)}::date) + 7)::timestamp AT TIME ZONE ${timezone})`;

const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 1000) / 10 : null);
const round1 = (value: number) => Math.round(value * 10) / 10;

@Injectable()
export class PerformanceService {
  constructor(private readonly configs: TenantConfigService) {}

  async weekly(tx: AppTx, context: TenantContext, query: WeeklyQuery): Promise<WeeklyResponse> {
    const detail = roleCan(context.role, { performance: ['read_detail'] });
    if (query.userId && !detail)
      throw new BadRequestException({ code: 'VALIDATION_ERROR', issues: [{ path: 'userId' }] });
    const timezone = await this.timezone(tx);
    const weeks = resolveWeeks(query, localTime(new Date(), timezone).date);
    const review = await this.reviewConfig(tx);

    const channels = await tx.execute<{
      id: string;
      name: string;
      phone_number: string | null;
      sellers: number;
    }>(sql`
      SELECT ch.id, ch.name, ch.phone_number,
        (SELECT count(*)::int FROM channel_members cm
          JOIN memberships ms ON ms.tenant_id = cm.tenant_id AND ms.user_id = cm.user_id
          WHERE cm.channel_id = ch.id AND ms.status = 'active' AND ms.role = 'seller') AS sellers
      FROM channels ch ORDER BY ch.name, ch.id
    `);
    const channelRefs = channels.rows.map((row) => ({
      id: row.id,
      name: row.name,
      phoneNumber: row.phone_number,
    }));
    const sellerOptions = detail ? await this.sellerOptions(tx) : null;

    const channelFilter = query.channelId ? sql`cm.channel_id = ${query.channelId}` : sql`true`;
    const userFilter = query.userId ? sql`cm.attributed_user_id = ${query.userId}` : sql`true`;
    const byChannel = await this.metricsRows(
      tx,
      weeks,
      timezone,
      sql`cm.channel_id`,
      sql`${channelFilter} AND ${userFilter}`,
    );
    const byChannelQuality = detail
      ? await this.qualityRows(tx, weeks, timezone, sql`r.channel_id`, query)
      : null;

    const shownChannels = channels.rows.filter((row) => !query.channelId || row.id === query.channelId);
    const result: WeeklyResponse = {
      timezone,
      weeks,
      channels: shownChannels.map((row) => ({
        channel: { id: row.id, name: row.name, phoneNumber: row.phone_number },
        sellersCount: detail ? row.sellers : null,
        weeks: weeks.map((week) => toWeek(week, row.id, byChannel, byChannelQuality, review, detail)),
      })),
      sellers: null,
      options: { channels: channelRefs, sellers: sellerOptions },
    };
    if (detail && sellerOptions) {
      // Solo conversaciones atribuibles (attribution <> 'none').
      const bySeller = await this.metricsRows(
        tx,
        weeks,
        timezone,
        sql`cm.attributed_user_id`,
        sql`cm.attribution <> 'none' AND ${channelFilter} AND ${userFilter}`,
      );
      const bySellerQuality = await this.qualityRows(
        tx,
        weeks,
        timezone,
        sql`r.attributed_user_id`,
        query,
        true,
      );
      const ids = new Set(bySeller.metrics.map((row) => row.grp));
      result.sellers = sellerOptions
        .filter((seller) => ids.has(seller.id) && (!query.userId || seller.id === query.userId))
        .map((seller) => ({
          user: seller,
          weeks: weeks.map((week) => ({
            ...toWeek(week, seller.id, bySeller, bySellerQuality, review, detail),
            unattributed: null,
          })),
        }));
    }
    return result;
  }

  async listReviews(tx: AppTx, query: ReviewListQuery) {
    const timezone = await this.timezone(tx);
    const weeks = resolveWeeks(query, localTime(new Date(), timezone).date);
    const conditions: SQL[] = [
      sql`r.last_message_at >= ${rangeStart(weeks, timezone)}`,
      sql`r.last_message_at < ${rangeEnd(weeks, timezone)}`,
    ];
    if (query.channelId) conditions.push(sql`r.channel_id = ${query.channelId}`);
    if (query.userId) conditions.push(sql`r.attributed_user_id = ${query.userId}`);
    if (query.outcome) conditions.push(sql`r.customer_outcome = ${query.outcome}`);
    if (query.issue)
      conditions.push(
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(r.output -> 'issues') i WHERE i ->> 'type' = ${query.issue})`,
      );
    if (query.lowCriterion)
      conditions.push(sql`(r.output -> 'criteria' -> ${query.lowCriterion} ->> 'score')::int <= 2`);
    const where = sql.join(conditions, sql` AND `);
    // La más nueva de cada conversación dentro del rango (el rango va adentro: no recorre todas las revisiones).
    const latest = sql`
      SELECT DISTINCT ON (r.conversation_id) r.* FROM conversation_reviews r
      WHERE r.last_message_at >= ${rangeStart(weeks, timezone)} AND r.last_message_at < ${rangeEnd(weeks, timezone)}
      ORDER BY r.conversation_id, r.created_at DESC`;
    const count = await tx.execute<{ total: number }>(sql`
      WITH latest AS (${latest}) SELECT count(*)::int AS total FROM latest r WHERE ${where}
    `);
    const rows = await tx.execute<{
      id: string;
      conversation_id: string;
      channel_id: string;
      channel_name: string;
      channel_phone: string | null;
      seller_id: string | null;
      seller_name: string | null;
      customer_outcome: ReviewOutput['customer_outcome']['value'];
      resolved: ReviewOutput['resolved'];
      output: ReviewOutput;
      disputed: boolean;
      last_message_at: string;
      created_at: string;
    }>(sql`
      WITH latest AS (${latest})
      SELECT r.id, r.conversation_id, r.channel_id, ch.name AS channel_name, ch.phone_number AS channel_phone,
        u.id AS seller_id, u.name AS seller_name, r.customer_outcome, r.resolved, r.output,
        EXISTS (SELECT 1 FROM conversation_review_disputes d WHERE d.review_id = r.id) AS disputed,
        ${iso(sql`r.last_message_at`)} AS last_message_at, ${iso(sql`r.created_at`)} AS created_at
      FROM latest r
      JOIN channels ch ON ch.id = r.channel_id
      LEFT JOIN users u ON u.id = r.attributed_user_id
      WHERE ${where}
      ORDER BY r.last_message_at DESC, r.id DESC
      LIMIT ${query.pageSize} OFFSET ${query.page * query.pageSize}
    `);
    return {
      total: count.rows[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      items: rows.rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        channel: { id: row.channel_id, name: row.channel_name, phoneNumber: row.channel_phone },
        seller: row.seller_id && row.seller_name ? { id: row.seller_id, name: row.seller_name } : null,
        customerOutcome: row.customer_outcome,
        resolved: row.resolved,
        issueTypes: [...new Set(row.output.issues.map((issue) => issue.type))] as IssueType[],
        average: averageOf(row.output),
        summary: row.output.summary,
        disputed: row.disputed,
        lastMessageAt: row.last_message_at,
        createdAt: row.created_at,
      })),
    };
  }

  async getReview(tx: AppTx, id: string): Promise<ReviewDetail> {
    const result = await tx.execute<{
      id: string;
      conversation_id: string;
      channel_id: string;
      channel_name: string;
      channel_phone: string | null;
      seller_id: string | null;
      seller_name: string | null;
      output: StoredOutput;
      discarded: unknown[];
      last_message_id: string;
      last_message_at: string;
      model: string;
      created_at: string;
      disputed_at: string | null;
      disputed_by_name: string | null;
      dispute_note: string | null;
    }>(sql`
      SELECT r.id, r.conversation_id, r.channel_id, ch.name AS channel_name, ch.phone_number AS channel_phone,
        u.id AS seller_id, u.name AS seller_name, r.output, r.discarded, r.last_message_id,
        ${iso(sql`r.last_message_at`)} AS last_message_at, r.model, ${iso(sql`r.created_at`)} AS created_at,
        ${iso(sql`d.created_at`)} AS disputed_at, du.name AS disputed_by_name, d.note AS dispute_note
      FROM conversation_reviews r
      JOIN channels ch ON ch.id = r.channel_id
      LEFT JOIN users u ON u.id = r.attributed_user_id
      LEFT JOIN conversation_review_disputes d ON d.review_id = r.id
      LEFT JOIN users du ON du.id = d.disputed_by
      WHERE r.id = ${id}
    `);
    const row = result.rows[0];
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND' });
    const configured = (await this.reviewConfig(tx))?.criteria ?? [];
    const labels = new Map(configured.map((item) => [item.key, item.label]));
    // En el orden de la config (jsonb no conserva el orden de las claves); los que ya no existen, al final.
    const order = (key: string) => {
      const index = configured.findIndex((item) => item.key === key);
      return index === -1 ? configured.length : index;
    };
    const evidence = (value: StoredEvidence | null) =>
      value ? { messageId: value.messageId ?? null, quote: value.quote } : null;
    const output = row.output;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      channel: { id: row.channel_id, name: row.channel_name, phoneNumber: row.channel_phone },
      seller: row.seller_id && row.seller_name ? { id: row.seller_id, name: row.seller_name } : null,
      customerOutcome: {
        value: output.customer_outcome.value,
        evidence: evidence(output.customer_outcome.evidence),
      },
      resolved: output.resolved,
      criteria: Object.entries(output.criteria)
        .sort(([a], [b]) => order(a) - order(b))
        .map(([key, value]) => ({
          key,
          label: labels.get(key) ?? null,
          score: value.score,
          evidence: evidence(value.evidence),
        })),
      issues: output.issues.map((issue) => ({
        type: issue.type,
        description: issue.description,
        evidence: evidence(issue.evidence)!,
      })),
      highlights: output.highlights.map((highlight) => ({
        description: highlight.description,
        evidence: evidence(highlight.evidence)!,
      })),
      coachingTip: output.coaching_tip,
      summary: output.summary,
      discardedCount: row.discarded.length,
      lastMessageId: row.last_message_id,
      lastMessageAt: row.last_message_at,
      model: row.model,
      createdAt: row.created_at,
      dispute: row.disputed_at
        ? { at: row.disputed_at, byName: row.disputed_by_name, note: row.dispute_note }
        : null,
    };
  }

  /** "No es correcta": idempotente (si ya está marcada, no cambia nada). */
  async dispute(
    tx: AppTx,
    context: TenantContext,
    id: string,
    note: string | undefined,
  ): Promise<ReviewDetail> {
    const exists = await tx.execute<{ id: string }>(
      sql`SELECT r.id FROM conversation_reviews r WHERE r.id = ${id}`,
    );
    if (exists.rows.length === 0) throw new NotFoundException({ code: 'NOT_FOUND' });
    await tx.execute(sql`
      INSERT INTO conversation_review_disputes (review_id, tenant_id, disputed_by, note)
      VALUES (${id}, app_tenant_id(), ${context.userId}, ${note || null})
      ON CONFLICT (review_id) DO NOTHING
    `);
    return this.getReview(tx, id);
  }

  async digests(tx: AppTx, query: { channelId?: string; from?: string; to?: string }) {
    const timezone = await this.timezone(tx);
    const weeks = resolveWeeks(query, localTime(new Date(), timezone).date);
    const rows = await tx.execute<{
      id: string;
      channel_id: string;
      channel_name: string;
      channel_phone: string | null;
      week_start: string;
      reviews_count: number;
      output: {
        improved: string;
        frequentProblems: string[];
        examples: { conversationId: string; reviewId: string; why: string }[];
      };
      created_at: string;
    }>(sql`
      SELECT d.id, d.channel_id, ch.name AS channel_name, ch.phone_number AS channel_phone,
        to_char(d.week_start, 'YYYY-MM-DD') AS week_start, d.reviews_count, d.output,
        ${iso(sql`d.created_at`)} AS created_at
      FROM review_digests d JOIN channels ch ON ch.id = d.channel_id
      WHERE d.week_start BETWEEN ${weeks[0]}::date AND ${weeks.at(-1)}::date
        AND (${query.channelId ?? null}::uuid IS NULL OR d.channel_id = ${query.channelId ?? null}::uuid)
      ORDER BY d.week_start DESC, ch.name
    `);
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        channel: { id: row.channel_id, name: row.channel_name, phoneNumber: row.channel_phone },
        weekStart: row.week_start,
        reviewsCount: row.reviews_count,
        improved: row.output.improved,
        frequentProblems: row.output.frequentProblems,
        examples: row.output.examples,
        createdAt: row.created_at,
      })),
    };
  }

  /**
   * Métricas de conversation_metrics por semana y grupo (número o vendedor). Candidatas: abiertas antes del
   * fin del rango y no cerradas antes de su comienzo. Ver docs/decisiones.md ("Métricas de Rendimiento").
   */
  private async metricsRows(tx: AppTx, weeks: string[], timezone: string, group: SQL, where: SQL) {
    const result = await tx.execute<MetricsRow>(sql`
      WITH weeks AS (
        SELECT gs::date AS week_start,
               gs AT TIME ZONE ${timezone} AS ws,
               (gs + interval '7 days') AT TIME ZONE ${timezone} AS we
        FROM generate_series(${weeks[0]}::timestamp, ${weeks.at(-1)}::timestamp, interval '7 days') gs
      ),
      m AS (
        SELECT cm.*, ${group} AS grp FROM conversation_metrics cm
        WHERE cm.opened_at < ${rangeEnd(weeks, timezone)}
          AND (cm.closed_at IS NULL OR cm.closed_at >= ${rangeStart(weeks, timezone)}) AND ${where}
      )
      SELECT to_char(w.week_start, 'YYYY-MM-DD') AS week_start, m.grp::text AS grp,
        count(*) FILTER (WHERE w.week_start = ANY (m.human_reply_weeks))::int AS attended,
        count(*) FILTER (WHERE w.week_start = ANY (m.human_reply_weeks) AND m.attribution = 'none')::int AS unattributed,
        count(*) FILTER (WHERE m.closed_at >= w.ws AND m.closed_at < w.we)::int AS closed_total,
        ${sql.join(
          OUTCOMES.map(
            (outcome) =>
              sql`count(*) FILTER (WHERE m.closed_at >= w.ws AND m.closed_at < w.we AND m.close_outcome = ${outcome})::int AS ${sql.identifier(`closed_${outcome}`)}`,
          ),
          sql`, `,
        )},
        count(*) FILTER (WHERE m.opened_at >= w.ws AND m.opened_at < w.we)::int AS new_total,
        count(*) FILTER (WHERE m.opened_at >= w.ws AND m.opened_at < w.we AND m.lead_tier_peak = 'hot')::int AS new_hot,
        count(*) FILTER (WHERE m.opened_at >= w.ws AND m.opened_at < w.we AND m.lead_tier_peak = 'warm')::int AS new_warm,
        count(*) FILTER (WHERE m.opened_at >= w.ws AND m.opened_at < w.we AND m.lead_tier_peak = 'cold')::int AS new_cold,
        count(*) FILTER (WHERE m.opened_at >= w.ws AND m.opened_at < w.we AND m.lead_tier_peak IS NULL)::int AS new_unrated,
        count(*) FILTER (WHERE m.handed_off_at >= w.ws AND m.handed_off_at < w.we)::int AS handed_off,
        count(*) FILTER (WHERE m.handed_off_at >= w.ws AND m.handed_off_at < w.we AND m.unanswered)::int
          AS handed_off_unanswered,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY m.handoff_response_seconds_business)
          FILTER (WHERE m.handed_off_at >= w.ws AND m.handed_off_at < w.we) AS p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY m.handoff_response_seconds_business)
          FILTER (WHERE m.handed_off_at >= w.ws AND m.handed_off_at < w.we) AS p90,
        count(m.handoff_response_seconds_business)
          FILTER (WHERE m.handed_off_at >= w.ws AND m.handed_off_at < w.we)::int AS responded,
        count(*) FILTER (WHERE m.closed_at >= w.ws AND m.closed_at < w.we AND m.handed_off_at IS NULL
          AND m.human_messages_count = 0 AND m.close_outcome <> 'auto_inactive')::int AS ai_only
      FROM weeks w CROSS JOIN m
      WHERE m.grp IS NOT NULL
      GROUP BY w.week_start, m.grp
    `);
    return { metrics: result.rows };
  }

  /** Calidad: la revisión más nueva de cada conversación en la semana de su último mensaje, sin las disputadas. */
  private async qualityRows(
    tx: AppTx,
    weeks: string[],
    timezone: string,
    group: SQL,
    query: WeeklyQuery,
    attributedOnly = false,
  ) {
    const filters = sql.join(
      [
        query.channelId ? sql`r.channel_id = ${query.channelId}` : sql`true`,
        query.userId ? sql`r.attributed_user_id = ${query.userId}` : sql`true`,
        attributedOnly ? sql`r.attributed_user_id IS NOT NULL` : sql`true`,
      ],
      sql` AND `,
    );
    const base = sql`
      weeks AS (
        SELECT gs::date AS week_start,
               gs AT TIME ZONE ${timezone} AS ws,
               (gs + interval '7 days') AT TIME ZONE ${timezone} AS we
        FROM generate_series(${weeks[0]}::timestamp, ${weeks.at(-1)}::timestamp, interval '7 days') gs
      ),
      latest AS (
        SELECT DISTINCT ON (r.conversation_id) r.id, r.channel_id, r.attributed_user_id, r.customer_outcome,
          r.output, r.last_message_at
        FROM conversation_reviews r
        WHERE r.last_message_at >= ${rangeStart(weeks, timezone)} AND r.last_message_at < ${rangeEnd(weeks, timezone)}
          AND ${filters}
        ORDER BY r.conversation_id, r.created_at DESC
      ),
      r AS (
        SELECT l.*, w.week_start FROM latest l
        JOIN weeks w ON l.last_message_at >= w.ws AND l.last_message_at < w.we
        WHERE NOT EXISTS (SELECT 1 FROM conversation_review_disputes d WHERE d.review_id = l.id)
      )`;
    const totals = await tx.execute<QualityRow>(sql`
      WITH ${base}
      SELECT to_char(r.week_start, 'YYYY-MM-DD') AS week_start, ${group}::text AS grp, count(*)::int AS reviews,
        count(*) FILTER (WHERE r.customer_outcome = 'satisfied')::int AS satisfied,
        count(*) FILTER (WHERE r.customer_outcome = 'neutral')::int AS neutral,
        count(*) FILTER (WHERE r.customer_outcome = 'dissatisfied')::int AS dissatisfied,
        count(*) FILTER (WHERE r.customer_outcome = 'unknown')::int AS unknown
      FROM r WHERE ${group} IS NOT NULL GROUP BY 1, 2
    `);
    const criteria = await tx.execute<CriteriaRow>(sql`
      WITH ${base}
      SELECT to_char(r.week_start, 'YYYY-MM-DD') AS week_start, ${group}::text AS grp, c.key,
        avg((c.value ->> 'score')::numeric)::float8 AS average
      FROM r, jsonb_each(r.output -> 'criteria') c
      WHERE ${group} IS NOT NULL AND c.value ->> 'score' IS NOT NULL
      GROUP BY 1, 2, 3
    `);
    return { totals: totals.rows, criteria: criteria.rows };
  }

  private async timezone(tx: AppTx): Promise<string> {
    const result = await tx.execute<{ timezone: string }>(
      sql`SELECT timezone FROM tenants WHERE id = app_tenant_id()`,
    );
    return result.rows[0]!.timezone;
  }

  private async reviewConfig(tx: AppTx): Promise<ReviewConfig | null> {
    const lookup = await this.configs.latest(tx);
    return lookup.kind === 'ok' ? lookup.config.review : null;
  }

  private async sellerOptions(tx: AppTx): Promise<{ id: string; name: string }[]> {
    const result = await tx.execute<{ id: string; name: string }>(sql`
      SELECT u.id, u.name FROM memberships ms JOIN users u ON u.id = ms.user_id
      WHERE ms.tenant_id = app_tenant_id()
        AND (ms.role = 'seller'
          -- Un owner o admin que respondió desde el panel también tiene conversaciones atribuidas.
          OR EXISTS (SELECT 1 FROM conversation_metrics cm WHERE cm.attributed_user_id = ms.user_id))
      ORDER BY u.name, u.id
    `);
    return result.rows;
  }
}

type StoredEvidence = { message: number; quote: string; messageId?: string | null };
type StoredOutput = Omit<ReviewOutput, 'customer_outcome' | 'criteria' | 'issues' | 'highlights'> & {
  customer_outcome: { value: ReviewOutput['customer_outcome']['value']; evidence: StoredEvidence | null };
  criteria: Record<string, { score: number | null; evidence: StoredEvidence | null }>;
  issues: { type: IssueType; description: string; evidence: StoredEvidence }[];
  highlights: { description: string; evidence: StoredEvidence }[];
};

function averageOf(output: ReviewOutput): number | null {
  const scores = Object.values(output.criteria)
    .map((value) => value.score)
    .filter((score): score is number => score !== null);
  return scores.length > 0 ? round1(scores.reduce((total, score) => total + score, 0) / scores.length) : null;
}

function toWeek(
  week: string,
  grp: string,
  metrics: { metrics: MetricsRow[] },
  quality: { totals: QualityRow[]; criteria: CriteriaRow[] } | null,
  review: ReviewConfig | null,
  detail: boolean,
): WeekMetrics {
  const row = metrics.metrics.find((item) => item.week_start === week && item.grp === grp);
  const n = (value: number | undefined) => value ?? 0;
  const result: WeekMetrics = {
    weekStart: week,
    attended: n(row?.attended),
    closed: {
      total: n(row?.closed_total),
      sold: n(row?.closed_sold),
      not_sold: n(row?.closed_not_sold),
      no_response: n(row?.closed_no_response),
      not_a_lead: n(row?.closed_not_a_lead),
      other: n(row?.closed_other),
      auto_inactive: n(row?.closed_auto_inactive),
    },
    newConversations: {
      total: n(row?.new_total),
      hot: n(row?.new_hot),
      warm: n(row?.new_warm),
      cold: n(row?.new_cold),
      unrated: n(row?.new_unrated),
    },
    handedOff: n(row?.handed_off),
    handedOffUnanswered: n(row?.handed_off_unanswered),
    handoffResponse: {
      p50Seconds: row?.p50 === null || row?.p50 === undefined ? null : Math.round(Number(row.p50)),
      p90Seconds: row?.p90 === null || row?.p90 === undefined ? null : Math.round(Number(row.p90)),
      count: n(row?.responded),
    },
    aiOnly: n(row?.ai_only),
    unattributed: detail ? n(row?.unattributed) : null,
    quality: null,
  };
  if (quality) {
    const totals = quality.totals.find((item) => item.week_start === week && item.grp === grp);
    const known = totals ? totals.satisfied + totals.neutral + totals.dissatisfied : 0;
    const averages = new Map(
      quality.criteria
        .filter((item) => item.week_start === week && item.grp === grp)
        .map((item) => [item.key, round1(Number(item.average))]),
    );
    const criteria = (review?.criteria ?? []).map((item) => ({
      key: item.key,
      label: item.label,
      average: averages.get(item.key) ?? null,
    }));
    const scored = criteria.map((item) => item.average).filter((value): value is number => value !== null);
    result.quality = {
      reviews: totals?.reviews ?? 0,
      satisfiedPct: pct(totals?.satisfied ?? 0, known),
      neutralPct: pct(totals?.neutral ?? 0, known),
      dissatisfiedPct: pct(totals?.dissatisfied ?? 0, known),
      unknown: totals?.unknown ?? 0,
      criteria,
      average:
        scored.length > 0 ? round1(scored.reduce((total, value) => total + value, 0) / scored.length) : null,
    };
  }
  return result;
}
