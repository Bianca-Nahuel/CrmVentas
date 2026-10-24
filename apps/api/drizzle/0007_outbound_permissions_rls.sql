-- Permisos, RLS y cola del outbox de envíos (tarea 005). La tabla, sus CHECKs, UNIQUEs y FKs compuestas
-- y las columnas nuevas de channels están en 0006 (generada desde apps/api/src/db/schema/messaging.ts).

-- 1. FK a usuarios de la MISMA empresa (mismo criterio que 0003) -----------------------------------------
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_sent_by_user_fk
  FOREIGN KEY (tenant_id, sent_by_user_id) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (sent_by_user_id);
--> statement-breakpoint

-- 2. updated_at (trigger compartido de 0001) ----------------------------------------------------------
CREATE TRIGGER outbound_messages_set_updated_at BEFORE UPDATE ON outbound_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- 3. Privilegios ----------------------------------------------------------------------------------------
-- Los default privileges le dan DML completo a ventas_app: se revoca y se da lo justo. ventas_auth nada.
REVOKE ALL ON outbound_messages FROM ventas_app, ventas_auth, PUBLIC;
--> statement-breakpoint
-- Sin DELETE: el outbox es el registro de lo que se intentó mandar (y por qué se rechazó).
GRANT SELECT, INSERT ON outbound_messages TO ventas_app;
--> statement-breakpoint
-- Solo las columnas de estado. El destino (conversación, canal), el texto, quién lo pidió y la clave de
-- idempotencia no cambian después de encolar.
GRANT UPDATE (status, reject_reason, attempts, last_error, claimed_at, external_id, message_id)
  ON outbound_messages TO ventas_app;
--> statement-breakpoint
-- Pausa de envíos del canal ante riesgo de bloqueo (la pone el worker, la saca dev:resume-channel).
GRANT UPDATE (sending_paused_until, sending_paused_reason) ON channels TO ventas_app;
--> statement-breakpoint

-- 4. RLS --------------------------------------------------------------------------------------------------
ALTER TABLE outbound_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbound_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outbound_messages TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- 5. Cola de envíos ---------------------------------------------------------------------------------------
-- policy singleton + singletonKey = conversation_id: un solo trabajo activo por chat (los demás esperan
-- en cola). No key_strict_fifo: un trabajo fallido bloquearía su chat para siempre.
-- Los trabajos llevan solo ids (outboundId, tenantId): el texto queda en outbound_messages.
-- expireInSeconds 60: el peor caso de un envío es ~40 s (visto 5 + escribiendo 5 + espera 8 + dejar de
-- escribir 5 + envío 15, más las transacciones). Si igual vence, el reintento encuentra la fila en
-- 'sending' y no reenvía.
-- Reintentos solo para lo que seguro no salió (transient, rate_limited): 10, 20, 40, 80, 120 s.
SELECT pgboss.create_queue('whatsapp-outbound', '{
  "policy": "singleton",
  "retryLimit": 5,
  "retryDelay": 10,
  "retryBackoff": true,
  "retryDelayMax": 120,
  "expireInSeconds": 60,
  "retentionSeconds": 86400,
  "deleteAfterSeconds": 86400
}'::jsonb);
