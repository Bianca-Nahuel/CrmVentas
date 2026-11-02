-- Permisos y RLS de la conexión de canales por QR (tarea 011). Columnas y channel_events están en 0019
-- (generada desde apps/api/src/db/schema/messaging.ts).

-- 1. Quién hizo cada acción: un miembro de la empresa. Si se quita la membresía, el registro queda sin usuario.
ALTER TABLE channel_events ADD CONSTRAINT channel_events_user_fk
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (user_id);
--> statement-breakpoint

-- 2. Privilegios ----------------------------------------------------------------------------------------
-- provider, connection_type y external_id identifican la sesión en el proveedor (resolve_channel): los
-- pone el sistema al crear el canal y nunca cambian ("Secuestro de número entre empresas" en
-- docs/decisiones.md). La aceptación del riesgo tampoco se reescribe: es el registro de quién la aceptó.
REVOKE UPDATE (provider, connection_type, external_id, risk_accepted_at, risk_accepted_by) ON channels FROM ventas_app;
--> statement-breakpoint
GRANT UPDATE (connected_at, disconnected_at, disconnect_reason) ON channels TO ventas_app;
--> statement-breakpoint
-- DELETE solo para "Cancelar" un canal que nunca se conectó (lo acota la política del punto 3).
GRANT DELETE ON channels TO ventas_app;
--> statement-breakpoint

-- channel_events: registro, solo SELECT e INSERT. ventas_auth nada.
REVOKE ALL ON channel_events FROM ventas_app, ventas_auth, PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON channel_events TO ventas_app;
--> statement-breakpoint

-- 3. RLS ------------------------------------------------------------------------------------------------
-- Las FKs desde conversations, messages, outbound_messages y channel_members borran en cascada (y la
-- cascada no pasa por RLS): un canal se puede borrar solo si nunca tuvo número, nunca se conectó y no
-- tiene conversaciones. RESTRICTIVE: se suma a tenant_isolation, que sigue exigiendo la empresa activa.
CREATE POLICY delete_never_connected ON channels AS RESTRICTIVE FOR DELETE TO ventas_app
  USING (
    phone_number IS NULL
    AND connected_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.channel_id = channels.id)
  );
--> statement-breakpoint

ALTER TABLE channel_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE channel_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON channel_events TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- 4. resolve_channel ------------------------------------------------------------------------------------
-- Igual que en 0003, y además descarta los canales cuyo escaneo se rechazó (otro teléfono, o un número
-- que ya está en otro canal): hasta que el proveedor cierre esa sesión, lo que llegue por ella no es de
-- esta empresa. Reconectar limpia el motivo y el canal vuelve a recibir.
CREATE OR REPLACE FUNCTION resolve_channel(p_provider text, p_external_id text)
  RETURNS TABLE (channel_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT c.id, c.tenant_id
    FROM public.channels c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.provider = p_provider
      AND c.external_id = p_external_id
      AND c.status <> 'banned'
      AND c.disconnect_reason IS DISTINCT FROM 'phone_mismatch'
      AND c.disconnect_reason IS DISTINCT FROM 'number_in_use'
      AND t.status = 'active'
  $$;
--> statement-breakpoint

-- 5. Cola para cerrar sesiones rechazadas ---------------------------------------------------------------
-- Si el escaneo se rechaza (otro teléfono, o un número que ya está en otro canal), el worker de
-- session.status encola, en su misma transacción, la desvinculación en el proveedor. Solo ids
-- ({ tenantId, channelId }). Reintentos con backoff (10, 20, 40, 80, 120 s): una llamada al proveedor que
-- falla no deja la sesión vinculada.
SELECT pgboss.create_queue('whatsapp-session-close', '{
  "policy": "standard",
  "retryLimit": 5,
  "retryDelay": 10,
  "retryBackoff": true,
  "retryDelayMax": 120,
  "expireInSeconds": 60,
  "retentionSeconds": 86400,
  "deleteAfterSeconds": 86400
}'::jsonb);
