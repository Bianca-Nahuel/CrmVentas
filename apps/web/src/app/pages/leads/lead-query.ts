// Estado de la grilla de leads en la URL (query params): se puede compartir, recargar y volver atrás.
// Lo que viene de la URL se valida acá; lo inválido se ignora (la API igual valida todo).
import type { ParamMap, Params } from '@angular/router';
import type { LeadState, ListLeads$Params } from '../../api/generated';

export type LeadSort = 'default' | 'score' | 'last_message';
export type LeadTierFilter = 'hot' | 'warm' | 'cold' | 'none';
/** Estado del filtro: el de la IA o "Cerradas" (tarea 026), que pide la vista de cerradas. */
export type LeadStatusFilter = LeadState | 'closed';
export const LEADS_PAGE_SIZE = 25;

export interface LeadQuery {
  sort: LeadSort;
  dir: 'asc' | 'desc';
  tier: LeadTierFilter | null;
  status: LeadStatusFilter | null;
  channel: string | null;
  q: string;
  page: number;
}

export const DEFAULT_QUERY: LeadQuery = {
  sort: 'default',
  dir: 'desc',
  tier: null,
  status: null,
  channel: null,
  q: '',
  page: 0,
};

const SORTS: readonly LeadSort[] = ['default', 'score', 'last_message'];
const TIERS: readonly LeadTierFilter[] = ['hot', 'warm', 'cold', 'none'];
const STATES: readonly LeadStatusFilter[] = ['open', 'handed_off', 'ai_paused', 'closed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const oneOf = <T extends string>(value: string | null, options: readonly T[]): T | null =>
  value !== null && (options as readonly string[]).includes(value) ? (value as T) : null;

export function parseLeadQuery(params: ParamMap): LeadQuery {
  const page = Number(params.get('page'));
  const q = (params.get('q') ?? '').slice(0, 100);
  const channel = params.get('channel');
  return {
    sort: oneOf(params.get('sort'), SORTS) ?? DEFAULT_QUERY.sort,
    dir: params.get('dir') === 'asc' ? 'asc' : 'desc',
    tier: oneOf(params.get('tier'), TIERS),
    status: oneOf(params.get('status'), STATES),
    channel: channel && UUID.test(channel) ? channel : null,
    q,
    page: Number.isInteger(page) && page > 0 && page <= 10_000 ? page : 0,
  };
}

/** Query params para la URL: solo lo que difiere del estado por defecto (null borra el parámetro). */
export function toQueryParams(query: LeadQuery): Params {
  return {
    sort: query.sort === DEFAULT_QUERY.sort ? null : query.sort,
    dir: query.dir === DEFAULT_QUERY.dir ? null : query.dir,
    tier: query.tier,
    status: query.status,
    channel: query.channel,
    q: query.q.trim() || null,
    page: query.page || null,
  };
}

/** Parámetros del pedido a GET /api/leads. Una búsqueda de 1 carácter no se manda (la API pide 2). */
export function toApiParams(query: LeadQuery, pageSize = LEADS_PAGE_SIZE): ListLeads$Params {
  const q = query.q.trim();
  return {
    sort: query.sort,
    dir: query.dir,
    ...(query.tier ? { tier: query.tier } : {}),
    ...(query.status === 'closed'
      ? { view: 'closed' as const }
      : query.status
        ? { status: query.status }
        : {}),
    ...(query.channel ? { channelId: query.channel } : {}),
    ...(q.length >= 2 ? { q } : {}),
    page: query.page,
    pageSize,
  };
}

export function hasFilters(query: LeadQuery): boolean {
  return Boolean(query.tier || query.status || query.channel || query.q.trim());
}
