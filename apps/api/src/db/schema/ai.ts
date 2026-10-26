// Tablas del agente de IA (tarea 006): configuración versionada por empresa y registro de cada corrida.
// Las FKs a memberships (created_by) y a messages/outbound_messages con tenant_id, los permisos, la RLS
// y la cola ai-reply están en la migración 0009.
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';

// Una versión no se edita nunca: un cambio inserta la siguiente. La vigente es la de mayor versión.
// Sin UPDATE ni DELETE para la app (0009).
export const tenantConfigs = pgTable(
  'tenant_configs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    // Validado con tenantConfigSchema (libs/shared) antes de insertar.
    config: jsonb('config').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tenant_configs_tenant_version_unique').on(t.tenantId, t.version),
    check('tenant_configs_version_check', sql`${t.version} > 0`),
    check('tenant_configs_config_object_check', sql`jsonb_typeof(${t.config}) = 'object'`),
  ],
);

// Registro de cada corrida del worker ai-reply, se llame o no al modelo. Sin el prompt: solo la salida
// estructurada, el puntaje y la decisión. Sin UPDATE ni DELETE para la app (0009).
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    // Entrante que disparó el trabajo (FK compuesta a messages en 0009: misma empresa y conversación).
    triggerMessageId: uuid('trigger_message_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    configVersion: integer('config_version'),
    // Nulos si no se llamó al modelo (filtros, disparadores sin modelo).
    provider: text('provider'),
    model: text('model'),
    billingMode: text('billing_mode'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),
    costSource: text('cost_source'),
    latencyMs: integer('latency_ms'),
    score: smallint('score'),
    scoreBreakdown: jsonb('score_breakdown'),
    triggersModel: jsonb('triggers_model').notNull().default([]),
    triggersCode: jsonb('triggers_code').notNull().default([]),
    decision: text('decision').notNull(),
    handoffReason: text('handoff_reason'),
    output: jsonb('output'),
    // Solo nombres y resultado de las herramientas, nunca argumentos ni respuestas.
    toolCalls: jsonb('tool_calls'),
    outboundMessageId: uuid('outbound_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_runs_tenant_conversation_idx').on(t.tenantId, t.conversationId, t.createdAt),
    check(
      'ai_runs_decision_check',
      sql`${t.decision} ~ '^(replied|asked_fields|asked_text|handed_off|none|skipped:[a-z_]+|blocked:[a-z_]+|error:[a-z_]+)$'`,
    ),
    check('ai_runs_handoff_reason_check', sql`${t.handoffReason} ~ '^[a-z0-9_:]{1,80}$'`),
    check('ai_runs_billing_mode_check', sql`${t.billingMode} IN ('platform', 'byok')`),
    check('ai_runs_cost_source_check', sql`${t.costSource} IN ('provider', 'estimated')`),
    check('ai_runs_provider_check', sql`${t.provider} IN ('openrouter', 'anthropic', 'openai')`),
    check('ai_runs_score_check', sql`${t.score} BETWEEN 0 AND 100`),
    check(
      'ai_runs_counters_check',
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.latencyMs} >= 0 AND ${t.costUsd} >= 0`,
    ),
  ],
);

export const aiSchema = { tenantConfigs, aiRuns };

export type TenantConfigRow = typeof tenantConfigs.$inferSelect;
export type AiRun = typeof aiRuns.$inferSelect;
export type NewAiRun = typeof aiRuns.$inferInsert;
