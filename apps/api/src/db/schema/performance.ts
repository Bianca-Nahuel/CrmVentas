// Revisión de vendedores (tarea 026): métricas por conversación, revisiones de calidad por IA, disputas y
// resumen semanal por número.
//
// Las FKs a memberships (tenant_id, user_id) con ON DELETE SET NULL (columna), los permisos, la RLS (por
// empresa, por número y solo owner/admin para las revisiones) y la cola performance-daily están en la
// migración 0022.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { channels, conversations, messages } from './messaging.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });

// Una fila por conversación, calculada por el código (PerformanceMetricsService) cada vez que se guarda un
// mensaje, se deriva o se cierra. Las fechas copiadas (opened_at, handed_off_at, closed_at) permiten
// agrupar por semana sin tocar conversations. Sin texto: fechas, contadores y quién respondió.
export const conversationMetrics = pgTable(
  'conversation_metrics',
  {
    conversationId: uuid('conversation_id').primaryKey(),
    tenantId: tenantId(),
    channelId: uuid('channel_id').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    firstInboundAt: timestamp('first_inbound_at', { withTimezone: true }),
    firstHumanReplyAt: timestamp('first_human_reply_at', { withTimezone: true }),
    // La primera derivación: si después se reactiva la IA, la métrica conserva la fecha original.
    handedOffAt: timestamp('handed_off_at', { withTimezone: true }),
    firstHumanReplyAfterHandoffAt: timestamp('first_human_reply_after_handoff_at', { withTimezone: true }),
    // En horario de atención (service_hours de la config, en tenants.timezone). NULL si no hay respuesta o
    // la empresa no tiene ninguna franja configurada.
    firstResponseSecondsBusiness: integer('first_response_seconds_business'),
    handoffResponseSecondsBusiness: integer('handoff_response_seconds_business'),
    humanMessagesCount: integer('human_messages_count').notNull().default(0),
    aiMessagesCount: integer('ai_messages_count').notNull().default(0),
    inboundCount: integer('inbound_count').notNull().default(0),
    humanParticipated: boolean('human_participated').notNull().default(false),
    // Lunes (hora local de la empresa) de cada semana con al menos una respuesta humana: "atendidas" por
    // semana sale de acá, sin leer messages (el viewer ve los totales pero no los mensajes).
    humanReplyWeeks: date('human_reply_weeks', { mode: 'string' })
      .array()
      .notNull()
      .default(sql`'{}'`),
    // Derivada sin ninguna respuesta humana después de la derivación.
    unanswered: boolean('unanswered').notNull().default(false),
    // Nivel máximo alcanzado (lead_score_peak con los umbrales vigentes al calcular).
    leadTierPeak: text('lead_tier_peak'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeOutcome: text('close_outcome'),
    // A quién se le atribuyen las respuestas humanas (docs/decisiones.md, "Atribución por vendedor"):
    // panel = todas desde el panel por la misma persona; single_seller = el número tenía un solo vendedor
    // asignado cuando llegó la primera respuesta humana; none = no se puede atribuir.
    attributedUserId: uuid('attributed_user_id'),
    attribution: text('attribution').notNull().default('none'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'conversation_metrics_conversation_fk',
      columns: [t.tenantId, t.conversationId, t.channelId],
      foreignColumns: [conversations.tenantId, conversations.id, conversations.channelId],
    }).onDelete('cascade'),
    index('conversation_metrics_opened_idx').on(t.tenantId, t.channelId, t.openedAt),
    index('conversation_metrics_handoff_idx')
      .on(t.tenantId, t.channelId, t.handedOffAt)
      .where(sql`${t.handedOffAt} IS NOT NULL`),
    index('conversation_metrics_closed_idx')
      .on(t.tenantId, t.channelId, t.closedAt)
      .where(sql`${t.closedAt} IS NOT NULL`),
    check(
      'conversation_metrics_counters_check',
      sql`${t.humanMessagesCount} >= 0 AND ${t.aiMessagesCount} >= 0 AND ${t.inboundCount} >= 0
        AND ${t.firstResponseSecondsBusiness} >= 0 AND ${t.handoffResponseSecondsBusiness} >= 0`,
    ),
    check('conversation_metrics_tier_check', sql`${t.leadTierPeak} IN ('hot', 'warm', 'cold')`),
    check(
      'conversation_metrics_close_outcome_check',
      sql`${t.closeOutcome} IN ('sold', 'not_sold', 'no_response', 'not_a_lead', 'other', 'auto_inactive')`,
    ),
    check(
      'conversation_metrics_attribution_check',
      sql`${t.attribution} IN ('panel', 'single_seller', 'none')
        AND (${t.attribution} = 'none') = (${t.attributedUserId} IS NULL)`,
    ),
  ],
);

// Revisión de calidad de una conversación (analista de IA). Nunca se edita: una revisión nueva (más
// mensajes) inserta otra fila; la disputa va en su propia tabla. output es la salida ya validada (con las
// citas verificadas); discarded, lo que se descartó y por qué (solo SELECT/INSERT, 0022).
export const conversationReviews = pgTable(
  'conversation_reviews',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    // Último mensaje que leyó el analista: la conversación se vuelve a revisar solo si hay uno más nuevo.
    lastMessageId: uuid('last_message_id').notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull(),
    promptVersion: text('prompt_version').notNull(),
    configVersion: integer('config_version').notNull(),
    model: text('model').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),
    customerOutcome: text('customer_outcome').notNull(),
    resolved: text('resolved').notNull(),
    output: jsonb('output').notNull(),
    discarded: jsonb('discarded').notNull().default([]),
    attributedUserId: uuid('attributed_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('conversation_reviews_tenant_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'conversation_reviews_conversation_fk',
      columns: [t.tenantId, t.conversationId, t.channelId],
      foreignColumns: [conversations.tenantId, conversations.id, conversations.channelId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversation_reviews_last_message_fk',
      columns: [t.tenantId, t.lastMessageId, t.conversationId],
      foreignColumns: [messages.tenantId, messages.id, messages.conversationId],
    }).onDelete('cascade'),
    index('conversation_reviews_channel_idx').on(t.tenantId, t.channelId, t.lastMessageAt),
    index('conversation_reviews_conversation_idx').on(t.conversationId, t.createdAt.desc()),
    // Una revisión por estado de la conversación: el trabajo diario y dev:review a la vez no la duplican.
    uniqueIndex('conversation_reviews_last_message_unique').on(t.conversationId, t.lastMessageId),
    index('conversation_reviews_created_idx').on(t.tenantId, t.createdAt),
    check(
      'conversation_reviews_customer_outcome_check',
      sql`${t.customerOutcome} IN ('satisfied', 'neutral', 'dissatisfied', 'unknown')`,
    ),
    check('conversation_reviews_resolved_check', sql`${t.resolved} IN ('yes', 'no', 'unknown')`),
    check('conversation_reviews_output_check', sql`jsonb_typeof(${t.output}) = 'object'`),
    check('conversation_reviews_discarded_check', sql`jsonb_typeof(${t.discarded}) = 'array'`),
    check('conversation_reviews_cost_check', sql`${t.costUsd} >= 0`),
  ],
);

// "No es correcta": la marca un owner o admin. La revisión queda fuera de los promedios. Una por revisión.
export const conversationReviewDisputes = pgTable(
  'conversation_review_disputes',
  {
    reviewId: uuid('review_id').primaryKey(),
    tenantId: tenantId(),
    disputedBy: uuid('disputed_by'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'conversation_review_disputes_review_fk',
      columns: [t.tenantId, t.reviewId],
      foreignColumns: [conversationReviews.tenantId, conversationReviews.id],
    }).onDelete('cascade'),
    check('conversation_review_disputes_note_check', sql`char_length(${t.note}) <= 500`),
  ],
);

// Resumen semanal por número, hecho a partir de las revisiones (no de los chats). Se muestra en el panel;
// no se envía por ningún canal.
export const reviewDigests = pgTable(
  'review_digests',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: tenantId(),
    channelId: uuid('channel_id').notNull(),
    // Lunes de la semana, en la zona horaria de la empresa.
    weekStart: date('week_start').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),
    reviewsCount: integer('reviews_count').notNull(),
    output: jsonb('output').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('review_digests_channel_week_unique').on(t.tenantId, t.channelId, t.weekStart),
    foreignKey({
      name: 'review_digests_channel_fk',
      columns: [t.tenantId, t.channelId],
      foreignColumns: [channels.tenantId, channels.id],
    }).onDelete('cascade'),
    check('review_digests_output_check', sql`jsonb_typeof(${t.output}) = 'object'`),
    check('review_digests_counters_check', sql`${t.reviewsCount} >= 0 AND ${t.costUsd} >= 0`),
  ],
);

export const performanceSchema = {
  conversationMetrics,
  conversationReviews,
  conversationReviewDisputes,
  reviewDigests,
};

export type ConversationMetrics = typeof conversationMetrics.$inferSelect;
export type ConversationReview = typeof conversationReviews.$inferSelect;
