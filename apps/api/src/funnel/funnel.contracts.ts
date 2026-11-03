// Contratos HTTP del embudo de ventas (tarea 028). Mismo esquema que performance.contracts.ts: validan los
// controllers y arman el OpenAPI del que el panel genera su cliente.
import { z } from 'zod';
import type { ApiRoute } from '../http/api-route.js';
import { leadRowSchema, leadTierSchema } from '../inbox/inbox.contracts.js';

const uuid = z.uuid();
const day = z.iso.date();

/** Días como máximo en un período, semanas como máximo con groupBy=week y días del período por defecto. */
export const FUNNEL_MAX_DAYS = 366;
export const FUNNEL_MAX_WEEKS = 26;
export const FUNNEL_DEFAULT_DAYS = 28;
export const FUNNEL_LEADS_MAX_PAGE_SIZE = 100;
export const STALLED_DEFAULT_DAYS = 3;

/** Etapas en orden. Cada una es "la alcanzó alguna vez" (ver docs/decisiones.md, embudo de ventas). */
export const FUNNEL_STAGES = ['written', 'qualified', 'hot', 'handed_off', 'attended', 'sold'] as const;
export const funnelStageSchema = z.enum(FUNNEL_STAGES).meta({ id: 'FunnelStage' });
export type FunnelStage = z.infer<typeof funnelStageSchema>;

/** Salidas que se pueden listar: los cierres sin venta, "no era un lead", inactividad y las abiertas. */
export const funnelOutcomeSchema = z
  .enum(['not_sold', 'no_response', 'other', 'not_a_lead', 'auto_inactive', 'open'])
  .meta({ id: 'FunnelOutcome' });

const booleanParam = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

// Filtros comunes del embudo y de sus listas: la cohorte son las conversaciones cuyo primer mensaje del
// cliente cae entre from y to (días, hora local de la empresa, inclusivos). Por defecto, los últimos 28 días.
const cohortFilters = {
  from: day.optional(),
  to: day.optional(),
  channelId: uuid.optional(),
  // Solo con performance.read_detail, sobre las conversaciones atribuibles (como en Rendimiento).
  userId: uuid.optional(),
  // Nivel máximo alcanzado.
  tier: leadTierSchema.optional(),
  excludeNotALead: booleanParam,
};

export const funnelQuerySchema = z
  .object({ ...cohortFilters, groupBy: z.enum(['total', 'week']).default('total') })
  .strict();
export type FunnelQuery = z.infer<typeof funnelQuerySchema>;

export const funnelLeadsQuerySchema = z
  .object({
    ...cohortFilters,
    stage: funnelStageSchema.optional(),
    // Alcanzaron la etapa, no la siguiente, ya están cerradas y no se vendieron. No vale con "sold".
    dropped: booleanParam,
    outcome: funnelOutcomeSchema.optional(),
    page: z.coerce.number().int().min(0).max(10_000).default(0),
    pageSize: z.coerce.number().int().min(1).max(FUNNEL_LEADS_MAX_PAGE_SIZE).default(25),
  })
  .strict();
export type FunnelLeadsQuery = z.infer<typeof funnelLeadsQuerySchema>;

export const stalledQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(30).default(STALLED_DEFAULT_DAYS),
    channelId: uuid.optional(),
    page: z.coerce.number().int().min(0).max(10_000).default(0),
    pageSize: z.coerce.number().int().min(1).max(FUNNEL_LEADS_MAX_PAGE_SIZE).default(25),
  })
  .strict();
export type StalledQuery = z.infer<typeof stalledQuerySchema>;

const durationSchema = z
  .object({
    // En horario de atención. null si no hay casos o la empresa no configuró el horario.
    p50Seconds: z.number().int().nullable(),
    p90Seconds: z.number().int().nullable(),
    count: z.number().int(),
  })
  .meta({ id: 'FunnelDuration' });

const closedWithoutSaleSchema = z
  .object({
    not_sold: z.number().int(),
    no_response: z.number().int(),
    other: z.number().int(),
    auto_inactive: z.number().int(),
  })
  .meta({ id: 'FunnelLossReasons' });

const funnelBlockSchema = z
  .object({
    stages: z.array(
      z
        .object({
          stage: funnelStageSchema,
          count: z.number().int(),
          // Porcentaje sobre "escribió" (0–100, un decimal). null sin conversaciones.
          pctOfWritten: z.number().nullable(),
          // Hacia la etapa siguiente (null en "vendido"): las que alcanzaron las dos / las de esta etapa.
          conversionToNext: z.number().nullable(),
          // Alcanzaron esta etapa y las dos.
          reachedNext: z.number().int().nullable(),
          // No alcanzaron la siguiente: cerradas sin venta (perdidas) y todavía abiertas.
          lostBeforeNext: z.number().int().nullable(),
          openBeforeNext: z.number().int().nullable(),
        })
        .meta({ id: 'FunnelStageCount' }),
    ),
    shortcuts: z
      .object({
        attendedWithoutHandoff: z.number().int(),
        soldWithoutHot: z.number().int(),
        soldAiOnly: z.number().int(),
      })
      .meta({ id: 'FunnelShortcuts' }),
    exits: z
      .object({
        // Cerradas sin venta, por motivo (no incluye "no era un lead").
        lost: closedWithoutSaleSchema,
        notALead: z.number().int(),
        inProgress: z.number().int(),
      })
      .meta({ id: 'FunnelExits' }),
    // Lo mismo, solo de las que llegaron a caliente.
    hotLost: closedWithoutSaleSchema,
    // Derivadas que nadie del equipo respondió después de la derivación.
    handedOffUnanswered: z.number().int(),
    times: z
      .object({ toHandoff: durationSchema, handoffToAttended: durationSchema, toSold: durationSchema })
      .meta({ id: 'FunnelTimes' }),
    amounts: z
      .object({
        // Plata como texto decimal (numeric), solo sobre las ventas con monto cargado.
        total: z.string().nullable(),
        average: z.string().nullable(),
        withAmount: z.number().int(),
        sold: z.number().int(),
      })
      .meta({ id: 'FunnelAmounts' }),
  })
  .meta({ id: 'FunnelBlock' });
export type FunnelBlock = z.infer<typeof funnelBlockSchema>;

const channelRefSchema = z
  .object({ id: uuid, name: z.string(), phoneNumber: z.string().nullable() })
  .meta({ id: 'FunnelChannelRef' });

export const funnelResponseSchema = z
  .object({
    timezone: z.string(),
    from: day,
    to: day,
    total: funnelBlockSchema,
    // Con groupBy=week: una cohorte por semana (lunes, hora local), de la más vieja a la más nueva.
    weeks: z
      .array(z.object({ weekStart: day, block: funnelBlockSchema }).meta({ id: 'FunnelWeek' }))
      .nullable(),
    options: z.object({
      channels: z.array(channelRefSchema),
      // null sin performance.read_detail.
      sellers: z.array(z.object({ id: uuid, name: z.string() })).nullable(),
    }),
    // Con userId: conversaciones de la cohorte que atendió una persona pero no se pueden atribuir a nadie.
    unattributed: z.number().int().nullable(),
  })
  .meta({ id: 'FunnelResponse' });
export type FunnelResponse = z.infer<typeof funnelResponseSchema>;

export const funnelLeadListSchema = z
  .object({
    items: z.array(leadRowSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'FunnelLeadList' });
export type FunnelLeadList = z.infer<typeof funnelLeadListSchema>;

export const stalledListSchema = z
  .object({
    items: z.array(leadRowSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    days: z.number().int(),
  })
  .meta({ id: 'StalledLeadList' });
export type StalledList = z.infer<typeof stalledListSchema>;

export const funnelRoutes: ApiRoute[] = [
  {
    method: 'get',
    path: '/funnel',
    operationId: 'getFunnel',
    summary: 'Embudo de ventas por cohorte: etapas, conversión, atajos, salidas, tiempos y montos',
    query: funnelQuerySchema,
    response: funnelResponseSchema,
  },
  {
    method: 'get',
    path: '/funnel/leads',
    operationId: 'listFunnelLeads',
    summary: 'Las conversaciones de una etapa, las que se cayeron en ella o las de una salida',
    query: funnelLeadsQuerySchema,
    response: funnelLeadListSchema,
  },
  {
    method: 'get',
    path: '/funnel/stalled',
    operationId: 'listStalledLeads',
    summary: 'Estancados: abiertas, con nivel máximo caliente y sin mensajes en N días',
    query: stalledQuerySchema,
    response: stalledListSchema,
  },
];
