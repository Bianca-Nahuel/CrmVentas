-- Permisos, RLS y visibilidad por número de la bandeja (tarea 014). Las tablas channel_members y
-- conversation_events están en 0014 (generada desde apps/api/src/db/schema/inbox.ts).

-- 1. FKs a usuarios de la MISMA empresa (mismo criterio que 0003) -----------------------------------------
-- El vendedor asignado es miembro de la empresa del número. Si se borra la membresía, se borra la asignación.
ALTER TABLE channel_members ADD CONSTRAINT channel_members_user_fk
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE channel_members ADD CONSTRAINT channel_members_created_by_fk
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (created_by);
--> statement-breakpoint
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_user_fk
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (user_id);
--> statement-breakpoint

-- 2. Privilegios ----------------------------------------------------------------------------------------
-- Los default privileges le dan DML completo a ventas_app: se revoca y se da lo justo. ventas_auth nada.
REVOKE ALL ON channel_members, conversation_events FROM ventas_app, ventas_auth, PUBLIC;
--> statement-breakpoint
-- Reemplazar los vendedores de un número borra e inserta: sin UPDATE.
GRANT SELECT, INSERT, DELETE ON channel_members TO ventas_app;
--> statement-breakpoint
-- Un evento es historial: ni se edita ni se borra.
GRANT SELECT, INSERT ON conversation_events TO ventas_app;
--> statement-breakpoint

-- 3. RLS por empresa --------------------------------------------------------------------------------------
ALTER TABLE channel_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE channel_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON channel_members TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_events TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- 4. Visibilidad por número -------------------------------------------------------------------------------
-- El control principal está en el servicio (ConversationScope, apps/api/src/inbox/). Esto es la red de
-- seguridad: si un endpoint se olvida del filtro, un seller igual no ve conversaciones de números que no
-- tiene asignados. Reemplaza el criterio de 0003 ("lo del seller va en los servicios"): ver
-- docs/decisiones.md.
--
-- Ve todos los números:
--   - sin app.user_id: workers de la cola y scripts (no los dispara un usuario);
--   - owner y admin (los que tienen read_all en libs/shared; un test compara las dos definiciones);
--   - un seller si la config vigente de la empresa tiene inbox.sellers_see_all_channels = true.
-- SECURITY DEFINER (mismo criterio que los helpers de 0001): lee memberships y tenant_configs sin depender
-- de sus políticas. search_path fijo y nombres calificados.
CREATE FUNCTION app_sees_all_channels() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT public.app_user_id() IS NULL OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.tenant_id = public.app_tenant_id()
        AND m.user_id = public.app_user_id()
        AND m.status = 'active'
        AND (
          m.role IN ('owner', 'admin')
          OR (
            m.role = 'seller'
            AND (
              SELECT c.config -> 'inbox' -> 'sellers_see_all_channels'
              FROM public.tenant_configs c
              WHERE c.tenant_id = m.tenant_id
              ORDER BY c.version DESC
              LIMIT 1
            ) = 'true'::jsonb
          )
        )
    )
  $$;
--> statement-breakpoint
-- Números asignados al seller del contexto (membresía activa) en la empresa activa.
CREATE FUNCTION app_visible_channel_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT cm.channel_id
    FROM public.channel_members cm
    JOIN public.memberships m ON m.tenant_id = cm.tenant_id AND m.user_id = cm.user_id
    WHERE cm.tenant_id = public.app_tenant_id()
      AND cm.user_id = public.app_user_id()
      AND m.status = 'active'
      AND m.role = 'seller'
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_sees_all_channels(), app_visible_channel_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_sees_all_channels(), app_visible_channel_ids() TO ventas_app;
--> statement-breakpoint

-- RESTRICTIVE: se suma (AND) a tenant_isolation. Sin FOR: vale para SELECT, INSERT, UPDATE y DELETE.
-- Dentro de (SELECT …) las funciones se evalúan una vez por consulta (initPlan o subplan hasheado), no por fila.
CREATE POLICY channel_visibility ON conversations AS RESTRICTIVE TO ventas_app
  USING ((SELECT app_sees_all_channels()) OR channel_id IN (SELECT app_visible_channel_ids()));
--> statement-breakpoint
CREATE POLICY channel_visibility ON messages AS RESTRICTIVE TO ventas_app
  USING ((SELECT app_sees_all_channels()) OR channel_id IN (SELECT app_visible_channel_ids()));
--> statement-breakpoint
CREATE POLICY channel_visibility ON outbound_messages AS RESTRICTIVE TO ventas_app
  USING ((SELECT app_sees_all_channels()) OR channel_id IN (SELECT app_visible_channel_ids()));
--> statement-breakpoint
-- ai_runs y conversation_events no tienen channel_id: valen si la conversación es visible (la subconsulta
-- aplica la RLS de conversations).
CREATE POLICY channel_visibility ON ai_runs AS RESTRICTIVE TO ventas_app
  USING (
    (SELECT app_sees_all_channels())
    OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = ai_runs.conversation_id)
  );
--> statement-breakpoint
CREATE POLICY channel_visibility ON conversation_events AS RESTRICTIVE TO ventas_app
  USING (
    (SELECT app_sees_all_channels())
    OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_events.conversation_id)
  );
