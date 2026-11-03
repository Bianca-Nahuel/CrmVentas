// Estado del embudo en la URL (tarea 028): período, filtros y la lista abierta. Funciones puras (se prueban
// sin TestBed). Lo que llega en la URL se valida: un valor raro vuelve al de por defecto.
import type { ParamMap, Params } from '@angular/router';
import type { FunnelOutcome, FunnelStage, GetFunnel$Params } from '../../api/generated';

export type LeadTier = NonNullable<GetFunnel$Params['tier']>;

export const PERIODS = ['week', '4w', '3m', 'range'] as const;
export type FunnelPeriod = (typeof PERIODS)[number];
export const PERIOD_LABELS: Record<FunnelPeriod, string> = {
  week: 'Esta semana',
  '4w': 'Últimas 4 semanas',
  '3m': 'Últimos 3 meses',
  range: 'Un rango',
};

export const STAGES: readonly FunnelStage[] = [
  'written',
  'qualified',
  'hot',
  'handed_off',
  'attended',
  'sold',
];
export const OUTCOMES: readonly FunnelOutcome[] = [
  'not_sold',
  'no_response',
  'other',
  'not_a_lead',
  'auto_inactive',
  'open',
];
const TIERS: readonly LeadTier[] = ['hot', 'warm', 'cold'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Lo mismo que la API: hasta 366 días, y la tendencia semanal hasta 26 semanas. */
export const MAX_DAYS = 366;
export const MAX_TREND_WEEKS = 26;

export interface FunnelQuery {
  period: FunnelPeriod;
  /** Solo con period = range. */
  from: string | null;
  to: string | null;
  channel: string | null;
  seller: string | null;
  tier: LeadTier | null;
  excludeNotALead: boolean;
  /** Lista abierta: una etapa (o las que se cayeron en ella) o una salida. */
  stage: FunnelStage | null;
  dropped: boolean;
  outcome: FunnelOutcome | null;
  /** Lista de estancados (excluye etapa y salida). */
  stalled: boolean;
  page: number;
}

export const DEFAULT_FUNNEL_QUERY: FunnelQuery = {
  period: '4w',
  from: null,
  to: null,
  channel: null,
  seller: null,
  tier: null,
  excludeNotALead: false,
  stage: null,
  dropped: false,
  outcome: null,
  stalled: false,
  page: 0,
};

const oneOf = <T extends string>(value: string | null, options: readonly T[]): T | null =>
  value !== null && (options as readonly string[]).includes(value) ? (value as T) : null;

export function parseFunnelQuery(params: ParamMap): FunnelQuery {
  const period = oneOf(params.get('period'), PERIODS) ?? DEFAULT_FUNNEL_QUERY.period;
  const from = params.get('from');
  const to = params.get('to');
  const validRange = period === 'range' && from && to && DAY.test(from) && DAY.test(to) && from <= to;
  const stalled = params.get('stalled') === '1';
  const stage = stalled ? null : oneOf(params.get('stage'), STAGES);
  const page = Number(params.get('lpage'));
  return {
    period: period === 'range' && !validRange ? DEFAULT_FUNNEL_QUERY.period : period,
    from: validRange ? from : null,
    to: validRange ? to : null,
    channel: UUID.test(params.get('channel') ?? '') ? params.get('channel') : null,
    seller: UUID.test(params.get('seller') ?? '') ? params.get('seller') : null,
    tier: oneOf(params.get('tier'), TIERS),
    excludeNotALead: params.get('nla') === '1',
    stage,
    // "Se cayó" no existe en la última etapa.
    dropped: stage !== null && stage !== 'sold' && params.get('dropped') === '1',
    outcome: stalled ? null : oneOf(params.get('outcome'), OUTCOMES),
    stalled,
    page: Number.isInteger(page) && page > 0 && page <= 10_000 ? page : 0,
  };
}

export function toFunnelParams(query: FunnelQuery): Params {
  const range = query.period === 'range';
  return {
    period: query.period === DEFAULT_FUNNEL_QUERY.period ? null : query.period,
    from: range ? query.from : null,
    to: range ? query.to : null,
    channel: query.channel,
    seller: query.seller,
    tier: query.tier,
    nla: query.excludeNotALead ? '1' : null,
    stage: query.stage,
    dropped: query.dropped ? '1' : null,
    outcome: query.outcome,
    stalled: query.stalled ? '1' : null,
    lpage: query.page || null,
  };
}

/** AAAA-MM-DD (fecha del navegador). */
export function formatDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}

/** Lunes de la semana del día. */
export function mondayOf(day: string): string {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

/** Días del período. "Esta semana": desde el lunes; 4 semanas: 28 días; 3 meses: 13 semanas (91 días). */
export function periodRange(query: FunnelQuery, today: string): { from: string; to: string } {
  switch (query.period) {
    case 'week':
      return { from: mondayOf(today), to: today };
    case '3m':
      return { from: addDays(today, -90), to: today };
    case 'range':
      return { from: query.from!, to: query.to! };
    default:
      return { from: addDays(today, -27), to: today };
  }
}

/** Semanas (lunes) que toca el período: la tendencia se pide por semana si no pasa de 26. */
export function weeksIn(range: { from: string; to: string }): number {
  return (
    (Date.parse(`${mondayOf(range.to)}T12:00:00Z`) - Date.parse(`${mondayOf(range.from)}T12:00:00Z`)) /
      (7 * 86_400_000) +
    1
  );
}

/** Parámetros del pedido del embudo. */
export function funnelApiParams(
  query: FunnelQuery,
  today: string,
  options: { detail: boolean },
): GetFunnel$Params {
  const range = periodRange(query, today);
  return {
    ...range,
    groupBy: weeksIn(range) <= MAX_TREND_WEEKS ? 'week' : 'total',
    ...(query.channel ? { channelId: query.channel } : {}),
    ...(options.detail && query.seller ? { userId: query.seller } : {}),
    ...(query.tier ? { tier: query.tier } : {}),
    ...(query.excludeNotALead ? { excludeNotALead: 'true' as const } : {}),
  };
}
