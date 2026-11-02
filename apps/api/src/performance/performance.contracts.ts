// Contratos HTTP de Rendimiento (tarea 026). Mismo esquema que inbox.contracts.ts: validan los controllers
// y arman el OpenAPI del que el panel genera su cliente.
import { z } from 'zod';
import type { ApiRoute } from '../http/api-route.js';
import { ISSUE_TYPES } from './review/prompt-v1.js';

const uuid = z.uuid();
const isoDate = z.iso.datetime({ offset: true });
const day = z.iso.date();

/** Semanas como máximo en una consulta. */
export const PERFORMANCE_MAX_WEEKS = 26;
export const PERFORMANCE_DEFAULT_WEEKS = 8;

export const weeklyQuerySchema = z
  .object({
    // Cualquier día de la semana: se toma el lunes (hora local de la empresa). Por defecto, las últimas 8.
    from: day.optional(),
    to: day.optional(),
    channelId: uuid.optional(),
    // Solo con performance.read_detail.
    userId: uuid.optional(),
  })
  .strict();
export type WeeklyQuery = z.infer<typeof weeklyQuerySchema>;

const closedByOutcomeSchema = z
  .object({
    total: z.number().int(),
    sold: z.number().int(),
    not_sold: z.number().int(),
    no_response: z.number().int(),
    not_a_lead: z.number().int(),
    other: z.number().int(),
    auto_inactive: z.number().int(),
  })
  .meta({ id: 'ClosedByOutcome' });

const qualitySchema = z
  .object({
    reviews: z.number().int(),
    // Porcentaje (0–100) sobre las revisiones con resultado conocido; null si no hay ninguna.
    satisfiedPct: z.number().nullable(),
    neutralPct: z.number().nullable(),
    dissatisfiedPct: z.number().nullable(),
    unknown: z.number().int(),
    // Promedio 1–5 de cada criterio de la config vigente (null si ninguna revisión lo puntuó).
    criteria: z.array(z.object({ key: z.string(), label: z.string(), average: z.number().nullable() })),
    // Promedio de los criterios con nota.
    average: z.number().nullable(),
  })
  .meta({ id: 'WeekQuality' });

export const weekMetricsSchema = z
  .object({
    weekStart: day,
    // Con al menos una respuesta de una persona del equipo en la semana.
    attended: z.number().int(),
    closed: closedByOutcomeSchema,
    newConversations: z
      .object({
        total: z.number().int(),
        hot: z.number().int(),
        warm: z.number().int(),
        cold: z.number().int(),
        unrated: z.number().int(),
      })
      .meta({ id: 'NewByTier' }),
    handedOff: z.number().int(),
    // De las derivadas en la semana, las que todavía no tienen respuesta humana.
    handedOffUnanswered: z.number().int(),
    // Primera respuesta humana después de la derivación, en horario de atención (segundos).
    handoffResponse: z
      .object({
        p50Seconds: z.number().nullable(),
        p90Seconds: z.number().nullable(),
        count: z.number().int(),
      })
      .meta({ id: 'ResponseTime' }),
    // Cerradas sin derivación ni respuesta humana (sin las cerradas por inactividad).
    aiOnly: z.number().int(),
    // Atendidas que no se pueden atribuir a un vendedor (solo por número y con read_detail).
    unattributed: z.number().int().nullable(),
    // null sin read_detail.
    quality: qualitySchema.nullable(),
  })
  .meta({ id: 'WeekMetrics' });
export type WeekMetrics = z.infer<typeof weekMetricsSchema>;

const channelRefSchema = z
  .object({ id: uuid, name: z.string(), phoneNumber: z.string().nullable() })
  .meta({ id: 'PerformanceChannel' });

export const weeklyResponseSchema = z
  .object({
    timezone: z.string(),
    weeks: z.array(day),
    channels: z.array(
      z
        .object({
          channel: channelRefSchema,
          // Vendedores asignados hoy (para explicar por qué no se puede atribuir).
          sellersCount: z.number().int().nullable(),
          weeks: z.array(weekMetricsSchema),
        })
        .meta({ id: 'ChannelWeeks' }),
    ),
    // null sin read_detail.
    sellers: z
      .array(
        z
          .object({ user: z.object({ id: uuid, name: z.string() }), weeks: z.array(weekMetricsSchema) })
          .meta({ id: 'SellerWeeks' }),
      )
      .nullable(),
    // Opciones de los filtros.
    options: z.object({
      channels: z.array(channelRefSchema),
      sellers: z.array(z.object({ id: uuid, name: z.string() })).nullable(),
    }),
  })
  .meta({ id: 'WeeklyPerformance' });
export type WeeklyResponse = z.infer<typeof weeklyResponseSchema>;

// ---- Revisiones ----

const evidenceSchema = z
  .object({ messageId: uuid.nullable(), quote: z.string() })
  .meta({ id: 'ReviewEvidence' });
const customerOutcomeSchema = z
  .enum(['satisfied', 'neutral', 'dissatisfied', 'unknown'])
  .meta({ id: 'CustomerOutcome' });
const issueTypeSchema = z.enum(ISSUE_TYPES).meta({ id: 'IssueType' });

export const reviewListQuerySchema = z
  .object({
    from: day.optional(),
    to: day.optional(),
    channelId: uuid.optional(),
    userId: uuid.optional(),
    outcome: customerOutcomeSchema.optional(),
    issue: issueTypeSchema.optional(),
    // Clave de un criterio: revisiones con nota 1 o 2 en ese criterio.
    lowCriterion: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional(),
    page: z.coerce.number().int().min(0).max(10_000).default(0),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;

const reviewRowSchema = z
  .object({
    id: uuid,
    conversationId: uuid,
    channel: channelRefSchema,
    seller: z.object({ id: uuid, name: z.string() }).nullable(),
    customerOutcome: customerOutcomeSchema,
    resolved: z.enum(['yes', 'no', 'unknown']),
    issueTypes: z.array(issueTypeSchema),
    average: z.number().nullable(),
    // Texto generado por el analista: se muestra como texto.
    summary: z.string(),
    disputed: z.boolean(),
    lastMessageAt: isoDate,
    createdAt: isoDate,
  })
  .meta({ id: 'ReviewRow' });

export const reviewListSchema = z
  .object({
    items: z.array(reviewRowSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'ReviewList' });

export const reviewParamsSchema = z.object({ id: uuid }).strict();

export const reviewDetailSchema = z
  .object({
    id: uuid,
    conversationId: uuid,
    channel: channelRefSchema,
    seller: z.object({ id: uuid, name: z.string() }).nullable(),
    customerOutcome: z.object({ value: customerOutcomeSchema, evidence: evidenceSchema.nullable() }),
    resolved: z.enum(['yes', 'no', 'unknown']),
    criteria: z.array(
      z
        .object({
          key: z.string(),
          // Etiqueta de la config vigente; null si el criterio ya no existe.
          label: z.string().nullable(),
          score: z.number().int().nullable(),
          evidence: evidenceSchema.nullable(),
        })
        .meta({ id: 'ReviewCriterion' }),
    ),
    issues: z.array(z.object({ type: issueTypeSchema, description: z.string(), evidence: evidenceSchema })),
    highlights: z.array(z.object({ description: z.string(), evidence: evidenceSchema })),
    coachingTip: z.string(),
    summary: z.string(),
    // Ítems que el código descartó porque su cita no estaba en la conversación.
    discardedCount: z.number().int(),
    // Hasta qué mensaje se revisó: los posteriores no los leyó el analista.
    lastMessageId: uuid,
    lastMessageAt: isoDate,
    model: z.string(),
    createdAt: isoDate,
    dispute: z
      .object({ at: isoDate, byName: z.string().nullable(), note: z.string().nullable() })
      .nullable()
      .meta({ id: 'ReviewDispute' }),
  })
  .meta({ id: 'ReviewDetail' });
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;

export const disputeBodySchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict()
  .meta({ id: 'DisputeReviewBody' });

export const digestListQuerySchema = z
  .object({ channelId: uuid.optional(), from: day.optional(), to: day.optional() })
  .strict();

export const digestListSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: uuid,
          channel: channelRefSchema,
          weekStart: day,
          reviewsCount: z.number().int(),
          // Generado por la IA a partir de las revisiones: se muestra como texto.
          improved: z.string(),
          frequentProblems: z.array(z.string()),
          examples: z.array(z.object({ conversationId: uuid, reviewId: uuid, why: z.string() })),
          createdAt: isoDate,
        })
        .meta({ id: 'ReviewDigest' }),
    ),
  })
  .meta({ id: 'ReviewDigestList' });

export const performanceRoutes: ApiRoute[] = [
  {
    method: 'get',
    path: '/performance/weekly',
    operationId: 'getWeeklyPerformance',
    summary: 'Métricas semanales por número (y por vendedor y calidad con performance.read_detail)',
    query: weeklyQuerySchema,
    response: weeklyResponseSchema,
  },
  {
    method: 'get',
    path: '/performance/reviews',
    operationId: 'listReviews',
    summary: 'Revisiones de calidad (la más nueva de cada conversación)',
    query: reviewListQuerySchema,
    response: reviewListSchema,
  },
  {
    method: 'get',
    path: '/performance/reviews/{id}',
    operationId: 'getReview',
    summary: 'Una revisión con sus citas',
    params: reviewParamsSchema,
    response: reviewDetailSchema,
  },
  {
    method: 'post',
    path: '/performance/reviews/{id}/dispute',
    operationId: 'disputeReview',
    summary: 'Marca la revisión como "no es correcta" (idempotente): sale de los promedios',
    params: reviewParamsSchema,
    body: disputeBodySchema,
    response: reviewDetailSchema,
  },
  {
    method: 'get',
    path: '/performance/digests',
    operationId: 'listReviewDigests',
    summary: 'Resúmenes semanales por número',
    query: digestListQuerySchema,
    response: digestListSchema,
  },
];
