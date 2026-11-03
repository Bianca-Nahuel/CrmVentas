import { BadRequestException, Injectable } from '@nestjs/common';
import { roleCan } from '@ventas/shared';
import { sql, type SQL } from 'drizzle-orm';
import { localTime } from '../ai/reply/business-hours.js';
import type { AppTx, TenantContext } from '../db/tenant-context.js';
import { ConversationScope, scopeCondition, type Scope } from '../inbox/conversation-scope.js';
import { InboxService } from '../inbox/inbox.service.js';
import { mondayOf } from '../performance/performance.service.js';
import {
  FUNNEL_DEFAULT_DAYS,
  FUNNEL_MAX_DAYS,
  FUNNEL_MAX_WEEKS,
  type FunnelLeadList,
  type FunnelLeadsQuery,
  type FunnelQuery,
  type FunnelResponse,
  type StalledList,
  type StalledQuery,
} from './funnel.contracts.js';
import { aggregateColumns, droppedAt, STAGE_SQL, toBlock, type FunnelRow } from './funnel-sql.js';

const DAY_MS = 86_400_000;
const parseDay = (day: string) =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const formatDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Cohort = { from: string; to: string; timezone: string };

/** Orden de las listas del embudo: como la grilla por defecto (puntaje, último mensaje). */
const LIST_ORDER = sql`c.lead_score DESC NULLS LAST, c.last_message_at DESC, c.id DESC`;
/** Estancados: los más calientes primero; a igual puntaje, el que lleva más tiempo sin mensajes. */
const STALLED_ORDER = sql`c.lead_score DESC NULLS LAST, c.last_message_at ASC, c.id ASC`;

const invalid = (...paths: string[]) =>
  new BadRequestException({ code: 'VALIDATION_ERROR', issues: paths.map((path) => ({ path })) });

/**
 * Embudo de ventas (tarea 028). Los conteos salen de conversation_metrics (el viewer lee los totales sin leer
 * conversaciones, #106); las listas, de las conversaciones con las mismas columnas que la grilla.
 */
@Injectable()
export class FunnelService {
  constructor(
    private readonly scopes: ConversationScope,
    private readonly inbox: InboxService,
  ) {}

  /**
   * Números del embudo: quien lee los totales de Rendimiento (performance.read: owner, admin y viewer, la
   * misma regla que app_reads_performance_totals en la RLS) ve todos; cualquier otro rol con metrics.read ve
   * solo los suyos (ConversationScope). La RLS de conversation_metrics repite la regla.
   */
  async metricsScope(tx: AppTx, context: TenantContext): Promise<Scope> {
    if (roleCan(context.role, { performance: ['read'] })) return { all: true };
    return this.scopes.resolve(tx, context);
  }

  async funnel(tx: AppTx, context: TenantContext, query: FunnelQuery): Promise<FunnelResponse> {
    const detail = roleCan(context.role, { performance: ['read_detail'] });
    if (query.userId && !detail) throw invalid('userId');
    const scope = await this.metricsScope(tx, context);
    const cohort = await this.cohort(tx, query);
    const weeks = query.groupBy === 'week' ? weeksOf(cohort) : null;
    const where = this.cohortWhere(scope, cohort, query);

    const total = await tx.execute<FunnelRow>(sql`
      SELECT ${aggregateColumns()} FROM conversation_metrics cm WHERE ${where}
    `);
    let byWeek: FunnelResponse['weeks'] = null;
    if (weeks) {
      const rows = await tx.execute<FunnelRow & { week_start: string }>(sql`
        SELECT to_char(date_trunc('week', cm.first_inbound_at AT TIME ZONE ${cohort.timezone}), 'YYYY-MM-DD')
                 AS week_start,
               ${aggregateColumns()}
        FROM conversation_metrics cm WHERE ${where}
        GROUP BY 1
      `);
      const found = new Map(rows.rows.map((row) => [row.week_start, row]));
      byWeek = weeks.map((weekStart) => ({ weekStart, block: toBlock(found.get(weekStart)) }));
    }

    let unattributed: number | null = null;
    if (query.userId) {
      const result = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM conversation_metrics cm
        WHERE ${this.cohortWhere(scope, cohort, { ...query, userId: undefined })}
          AND cm.first_human_reply_at IS NOT NULL AND cm.attribution = 'none'
      `);
      unattributed = result.rows[0]?.n ?? 0;
    }

    const channels = await tx.execute<{ id: string; name: string; phone_number: string | null }>(sql`
      SELECT ch.id, ch.name, ch.phone_number FROM channels ch
      WHERE ${scopeCondition(scope, sql`ch.id`)} ORDER BY ch.name, ch.id
    `);
    return {
      timezone: cohort.timezone,
      from: cohort.from,
      to: cohort.to,
      total: toBlock(total.rows[0]),
      weeks: byWeek,
      options: {
        channels: channels.rows.map((row) => ({ id: row.id, name: row.name, phoneNumber: row.phone_number })),
        sellers: detail ? await this.sellerOptions(tx) : null,
      },
      unattributed,
    };
  }

  /** Conversaciones de una etapa, las que se cayeron en ella o las de una salida (misma cohorte y filtros). */
  async leads(tx: AppTx, context: TenantContext, query: FunnelLeadsQuery): Promise<FunnelLeadList> {
    if (query.userId && !roleCan(context.role, { performance: ['read_detail'] })) throw invalid('userId');
    if (query.dropped && !query.stage) throw invalid('stage');
    const scope = await this.metricsScope(tx, context);
    const cohort = await this.cohort(tx, query);
    const conditions: SQL[] = [this.cohortWhere(scope, cohort, query)];
    if (query.stage) {
      const dropped = query.dropped ? droppedAt(query.stage) : STAGE_SQL[query.stage];
      if (!dropped) throw invalid('dropped');
      conditions.push(dropped);
    }
    if (query.outcome) {
      conditions.push(
        query.outcome === 'open' ? sql`cm.closed_at IS NULL` : sql`cm.close_outcome = ${query.outcome}`,
      );
    }
    const where = sql`c.id IN (
      SELECT cm.conversation_id FROM conversation_metrics cm WHERE ${sql.join(conditions, sql` AND `)}
    )`;
    const page = await this.inbox.leadRowsWhere(tx, context, where, {
      orderBy: LIST_ORDER,
      page: query.page,
      pageSize: query.pageSize,
    });
    return { ...page, page: query.page, pageSize: query.pageSize };
  }

  /** Abiertas, con nivel máximo caliente y sin mensajes (de ningún lado) en `days` días. */
  async stalled(tx: AppTx, context: TenantContext, query: StalledQuery): Promise<StalledList> {
    const conditions: SQL[] = [
      sql`c.status = 'open'`,
      sql`c.lead_tier_peak = 'hot'`,
      sql`c.last_message_at < now() - make_interval(days => ${query.days}::int)`,
    ];
    if (query.channelId) conditions.push(sql`c.channel_id = ${query.channelId}`);
    const page = await this.inbox.leadRowsWhere(tx, context, sql.join(conditions, sql` AND `), {
      orderBy: STALLED_ORDER,
      page: query.page,
      pageSize: query.pageSize,
    });
    return { ...page, page: query.page, pageSize: query.pageSize, days: query.days };
  }

  /** Período pedido (días locales, inclusivos), con el valor por defecto y el tope. */
  private async cohort(tx: AppTx, query: { from?: string; to?: string }): Promise<Cohort> {
    const result = await tx.execute<{ timezone: string }>(
      sql`SELECT timezone FROM tenants WHERE id = app_tenant_id()`,
    );
    const timezone = result.rows[0]!.timezone;
    const to = query.to ?? localTime(new Date(), timezone).date;
    const from = query.from ?? formatDay(parseDay(to) - (FUNNEL_DEFAULT_DAYS - 1) * DAY_MS);
    const days = (parseDay(to) - parseDay(from)) / DAY_MS + 1;
    if (days < 1 || days > FUNNEL_MAX_DAYS) throw invalid('from', 'to');
    return { from, to, timezone };
  }

  /**
   * La cohorte (primer mensaje del cliente en el período, hora local) con los filtros. Los límites van como
   * expresiones constantes: el planificador las evalúa una vez y usa conversation_metrics_first_inbound_idx.
   */
  private cohortWhere(
    scope: Scope,
    cohort: Cohort,
    query: Pick<FunnelQuery, 'channelId' | 'userId' | 'tier' | 'excludeNotALead'>,
  ): SQL {
    const conditions: SQL[] = [
      sql`cm.first_inbound_at >= ((${cohort.from}::date)::timestamp AT TIME ZONE ${cohort.timezone})`,
      sql`cm.first_inbound_at < (((${cohort.to}::date) + 1)::timestamp AT TIME ZONE ${cohort.timezone})`,
      scopeCondition(scope, sql`cm.channel_id`),
    ];
    if (query.channelId) conditions.push(sql`cm.channel_id = ${query.channelId}`);
    if (query.userId) {
      // Solo las atribuibles, con la misma regla que Rendimiento (docs/decisiones.md, "Atribución").
      conditions.push(sql`cm.attribution <> 'none' AND cm.attributed_user_id = ${query.userId}`);
    }
    if (query.tier) conditions.push(sql`cm.lead_tier_peak = ${query.tier}`);
    if (query.excludeNotALead) conditions.push(sql`cm.close_outcome IS DISTINCT FROM 'not_a_lead'`);
    return sql.join(conditions, sql` AND `);
  }

  /** Igual que en Rendimiento: vendedores y quien tenga conversaciones atribuidas. */
  private async sellerOptions(tx: AppTx): Promise<{ id: string; name: string }[]> {
    const result = await tx.execute<{ id: string; name: string }>(sql`
      SELECT u.id, u.name FROM memberships ms JOIN users u ON u.id = ms.user_id
      WHERE ms.tenant_id = app_tenant_id()
        AND (ms.role = 'seller'
          OR EXISTS (SELECT 1 FROM conversation_metrics cm WHERE cm.attributed_user_id = ms.user_id))
      ORDER BY u.name, u.id
    `);
    return result.rows;
  }
}

/** Lunes de cada semana del período (cohortes semanales), con el tope de 26. */
export function weeksOf(cohort: { from: string; to: string }): string[] {
  const first = parseDay(mondayOf(cohort.from));
  const last = parseDay(mondayOf(cohort.to));
  const count = (last - first) / (7 * DAY_MS) + 1;
  if (count > FUNNEL_MAX_WEEKS) throw invalid('from', 'to');
  return Array.from({ length: count }, (_, index) => formatDay(first + index * 7 * DAY_MS));
}
