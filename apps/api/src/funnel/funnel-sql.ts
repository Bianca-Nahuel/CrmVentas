// Definiciones del embudo (tarea 028) en SQL sobre conversation_metrics (alias cm) y el armado de la
// respuesta desde una fila de conteos. Un solo lugar para las etapas: lo usan el embudo, sus listas y los
// tests. Ver docs/decisiones.md ("Embudo de ventas").
import { sql, type SQL } from 'drizzle-orm';
import { FUNNEL_STAGES, type FunnelBlock, type FunnelStage } from './funnel.contracts.js';

/**
 * "La alcanzó alguna vez". COALESCE: un nivel NULL no es "calificado" ni "no calificado" para SQL, y un NOT
 * sobre NULL dejaría la fila afuera de los perdidos.
 */
export const STAGE_SQL: Record<FunnelStage, SQL> = {
  written: sql`true`,
  qualified: sql`COALESCE(cm.lead_tier_peak IN ('warm', 'hot'), false)`,
  hot: sql`COALESCE(cm.lead_tier_peak = 'hot', false)`,
  // La primera derivación: no se borra al reactivar la IA (conversation-metrics.ts).
  handed_off: sql`(cm.handed_off_at IS NOT NULL)`,
  // Respondió una persona del equipo al menos una vez (con o sin derivación).
  attended: sql`(cm.first_human_reply_at IS NOT NULL)`,
  sold: sql`COALESCE(cm.close_outcome = 'sold', false)`,
};

const CLOSED = sql`(cm.closed_at IS NOT NULL)`;
const NOT_SOLD = sql`(cm.close_outcome IS DISTINCT FROM 'sold')`;

export function nextStage(stage: FunnelStage): FunnelStage | null {
  return FUNNEL_STAGES[FUNNEL_STAGES.indexOf(stage) + 1] ?? null;
}

/** Alcanzó la etapa, no la siguiente, ya está cerrada y no se vendió (una venta por un atajo no se perdió). */
export function droppedAt(stage: FunnelStage): SQL | null {
  const next = nextStage(stage);
  if (!next) return null;
  return sql`(${STAGE_SQL[stage]} AND NOT ${STAGE_SQL[next]} AND ${CLOSED} AND ${NOT_SOLD})`;
}

/** Alcanzó la etapa, no la siguiente y sigue abierta. */
function openAt(stage: FunnelStage): SQL | null {
  const next = nextStage(stage);
  if (!next) return null;
  return sql`(${STAGE_SQL[stage]} AND NOT ${STAGE_SQL[next]} AND NOT ${CLOSED})`;
}

const LOSS_OUTCOMES = ['not_sold', 'no_response', 'other', 'auto_inactive'] as const;

/** Conteos con nombre → condición. Los nombres son las columnas de FunnelRow. */
function counters(): [string, SQL][] {
  const list: [string, SQL][] = [];
  for (const stage of FUNNEL_STAGES) {
    list.push([`n_${stage}`, STAGE_SQL[stage]]);
    const next = nextStage(stage);
    if (next) {
      list.push([`both_${stage}`, sql`(${STAGE_SQL[stage]} AND ${STAGE_SQL[next]})`]);
      list.push([`lost_${stage}`, droppedAt(stage)!]);
      list.push([`open_${stage}`, openAt(stage)!]);
    }
  }
  list.push(['short_attended_without_handoff', sql`(${STAGE_SQL.attended} AND NOT ${STAGE_SQL.handed_off})`]);
  list.push(['short_sold_without_hot', sql`(${STAGE_SQL.sold} AND NOT ${STAGE_SQL.hot})`]);
  list.push(['short_sold_ai_only', sql`(${STAGE_SQL.sold} AND NOT ${STAGE_SQL.attended})`]);
  for (const outcome of LOSS_OUTCOMES) {
    list.push([`exit_${outcome}`, sql`(cm.close_outcome = ${outcome})`]);
    list.push([`hot_${outcome}`, sql`(${STAGE_SQL.hot} AND cm.close_outcome = ${outcome})`]);
  }
  list.push(['exit_not_a_lead', sql`(cm.close_outcome = 'not_a_lead')`]);
  list.push(['in_progress', sql`(NOT ${CLOSED})`]);
  list.push(['handed_off_unanswered', sql`(${STAGE_SQL.handed_off} AND cm.unanswered)`]);
  return list;
}

const TIMES = {
  t_handoff: sql`cm.handoff_seconds_business`,
  t_attend: sql`cm.handoff_response_seconds_business`,
  t_sold: sql`cm.sold_seconds_business`,
};

/** Columnas agregadas del SELECT (conteos, percentiles y montos). */
export function aggregateColumns(): SQL {
  const parts: SQL[] = counters().map(
    ([name, condition]) => sql`count(*) FILTER (WHERE ${condition})::int AS ${sql.identifier(name)}`,
  );
  for (const [name, column] of Object.entries(TIMES)) {
    parts.push(
      sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${column}) AS ${sql.identifier(`${name}_p50`)}`,
    );
    parts.push(
      sql`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${column}) AS ${sql.identifier(`${name}_p90`)}`,
    );
    parts.push(sql`count(${column})::int AS ${sql.identifier(`${name}_count`)}`);
  }
  parts.push(sql`(sum(cm.close_amount) FILTER (WHERE ${STAGE_SQL.sold}))::text AS amount_total`);
  parts.push(sql`(round(avg(cm.close_amount) FILTER (WHERE ${STAGE_SQL.sold}), 2))::text AS amount_average`);
  parts.push(sql`count(cm.close_amount) FILTER (WHERE ${STAGE_SQL.sold})::int AS amount_count`);
  return sql.join(parts, sql`, `);
}

export type FunnelRow = Record<string, number | string | null>;

const n = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));
const seconds = (value: unknown) =>
  value === null || value === undefined ? null : Math.round(Number(value));
/** Porcentaje con un decimal; null si no hay base. */
export const pct = (part: number, total: number) =>
  total > 0 ? Math.round((part / total) * 1000) / 10 : null;

/** Una fila de conteos (o undefined: sin conversaciones) → el bloque de la respuesta. */
export function toBlock(row: FunnelRow | undefined): FunnelBlock {
  const get = (name: string) => n(row?.[name]);
  const written = get('n_written');
  const stages = FUNNEL_STAGES.map((stage) => {
    const count = get(`n_${stage}`);
    const hasNext = nextStage(stage) !== null;
    return {
      stage,
      count,
      pctOfWritten: pct(count, written),
      conversionToNext: hasNext ? pct(get(`both_${stage}`), count) : null,
      reachedNext: hasNext ? get(`both_${stage}`) : null,
      lostBeforeNext: hasNext ? get(`lost_${stage}`) : null,
      openBeforeNext: hasNext ? get(`open_${stage}`) : null,
    };
  });
  const losses = (prefix: string) => ({
    not_sold: get(`${prefix}_not_sold`),
    no_response: get(`${prefix}_no_response`),
    other: get(`${prefix}_other`),
    auto_inactive: get(`${prefix}_auto_inactive`),
  });
  const time = (name: keyof typeof TIMES) => ({
    p50Seconds: seconds(row?.[`${name}_p50`]),
    p90Seconds: seconds(row?.[`${name}_p90`]),
    count: get(`${name}_count`),
  });
  const total = row?.amount_total;
  const average = row?.amount_average;
  return {
    stages,
    shortcuts: {
      attendedWithoutHandoff: get('short_attended_without_handoff'),
      soldWithoutHot: get('short_sold_without_hot'),
      soldAiOnly: get('short_sold_ai_only'),
    },
    exits: { lost: losses('exit'), notALead: get('exit_not_a_lead'), inProgress: get('in_progress') },
    hotLost: losses('hot'),
    handedOffUnanswered: get('handed_off_unanswered'),
    times: { toHandoff: time('t_handoff'), handoffToAttended: time('t_attend'), toSold: time('t_sold') },
    amounts: {
      total: typeof total === 'string' ? total : null,
      average: typeof average === 'string' ? average : null,
      withAmount: get('amount_count'),
      sold: get('n_sold'),
    },
  };
}
