-- Permisos, RLS, FKs entre empresas y cola del agente de IA (tarea 006). Las tablas tenant_configs y
-- ai_runs y las columnas nuevas de conversations están en 0008 (generada desde apps/api/src/db/schema/).

-- 1. FKs con tenant_id (mismo criterio que 0003 y 0007) -------------------------------------------------
-- Quien cargó una versión de la config tiene que ser miembro de la empresa. NULL si la cargó un script.
ALTER TABLE tenant_configs ADD CONSTRAINT tenant_configs_created_by_fk
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (created_by);
--> statement-breakpoint
-- El entrante que disparó la corrida es de la misma empresa y de la misma conversación.
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_trigger_message_fk
  FOREIGN KEY (tenant_id, trigger_message_id, conversation_id)
  REFERENCES messages (tenant_id, id, conversation_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_outbound_message_fk
  FOREIGN KEY (tenant_id, outbound_message_id) REFERENCES outbound_messages (tenant_id, id)
  ON DELETE SET NULL (outbound_message_id);
--> statement-breakpoint
-- Contar las preguntas de un disparador after_fields y si ya se pidió texto (por conversación).
CREATE INDEX ai_runs_conversation_decision_idx ON ai_runs (conversation_id, decision);
--> statement-breakpoint

-- 2. Privilegios ----------------------------------------------------------------------------------------
-- Los default privileges le dan DML completo a ventas_app: se revoca y se da lo justo. ventas_auth nada.
REVOKE ALL ON tenant_configs, ai_runs FROM ventas_app, ventas_auth, PUBLIC;
--> statement-breakpoint
-- Una versión de la config nunca se edita (se inserta la siguiente) y una corrida es historial.
GRANT SELECT, INSERT ON tenant_configs, ai_runs TO ventas_app;
--> statement-breakpoint
-- Solo las columnas que escribe el worker de la IA. El resto de la conversación queda como en 0003.
GRANT UPDATE (lead_score, lead_score_peak, lead_score_at, score_breakdown, lead_tier, qualification_turns,
  hot_turns, suggestions_count, extracted_data, discovered_notes, handed_off_at, handoff_reason,
  handoff_summary) ON conversations TO ventas_app;
--> statement-breakpoint

-- 3. RLS --------------------------------------------------------------------------------------------------
ALTER TABLE tenant_configs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_configs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_configs TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_runs TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- 4. Cola del agente ------------------------------------------------------------------------------------
-- Un trabajo por entrante nuevo, con startAfter 10 s (debounce). policy singleton + singletonKey =
-- conversation_id: puede haber varios esperando, pero solo uno activo por conversación (índice único de
-- pg-boss sobre state = 'active'), así dos corridas nunca se pisan. short/stately descartarían el trabajo
-- del mensaje más nuevo.
-- Los trabajos llevan solo ids. expireInSeconds 150: peor caso ~2 llamadas de 30 s + reintento + base. Si
-- igual vence, el reintento termina en la T2 (lock de la conversación) y el envío es idempotente.
-- Reintentos solo por errores de base: los del modelo se resuelven dentro del worker.
SELECT pgboss.create_queue('ai-reply', '{
  "policy": "singleton",
  "retryLimit": 2,
  "retryDelay": 15,
  "retryBackoff": true,
  "expireInSeconds": 150,
  "retentionSeconds": 86400,
  "deleteAfterSeconds": 86400
}'::jsonb);
