-- Permisos, RLS y colas de la revisión de vendedores (tarea 026). Columnas de cierre y tablas nuevas en
-- 0021 (generada desde apps/api/src/db/schema/messaging.ts y performance.ts).

-- 1. FKs a usuarios de la MISMA empresa (mismo criterio que 0003) -----------------------------------------
ALTER TABLE conversations ADD CONSTRAINT conversations_closed_by_fk
  FOREIGN KEY (tenant_id, closed_by) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (closed_by);
--> statement-breakpoint
-- Si se borra la membresía, la conversación deja de estar atribuida (attribution pasa a 'none' con el
-- trigger del punto 2).
ALTER TABLE conversation_metrics ADD CONSTRAINT conversation_metrics_attributed_user_fk
  FOREIGN KEY (tenant_id, attributed_user_id) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (attributed_user_id);
--> statement-breakpoint
ALTER TABLE conversation_reviews ADD CONSTRAINT conversation_reviews_attributed_user_fk
  FOREIGN KEY (tenant_id, attributed_user_id) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (attributed_user_id);
--> statement-breakpoint
ALTER TABLE conversation_review_disputes ADD CONSTRAINT conversation_review_disputes_user_fk
  FOREIGN KEY (tenant_id, disputed_by) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (disputed_by);
--> statement-breakpoint

-- 2. Triggers ------------------------------------------------------------------------------------------
CREATE TRIGGER conversation_metrics_set_updated_at BEFORE UPDATE ON conversation_metrics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- El SET NULL de la FK anula solo attributed_user_id; el CHECK de atribución exige que attribution pase a
-- 'none' en la misma fila. Este trigger lo hace antes de que se evalúe el CHECK.
CREATE FUNCTION conversation_metrics_clear_attribution() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.attributed_user_id IS NULL THEN
      NEW.attribution := 'none';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER conversation_metrics_clear_attribution BEFORE UPDATE OF attributed_user_id ON conversation_metrics
  FOR EACH ROW EXECUTE FUNCTION conversation_metrics_clear_attribution();
--> statement-breakpoint

-- 3. Privilegios ----------------------------------------------------------------------------------------
-- Cerrar: solo las columnas de cierre (status ya tiene UPDATE desde 0003).
GRANT UPDATE (closed_at, closed_by, close_outcome, close_note) ON conversations TO ventas_app;
--> statement-breakpoint
-- Los default privileges le dan DML completo a ventas_app: se revoca y se da lo justo. ventas_auth nada.
REVOKE ALL ON conversation_metrics, conversation_reviews, conversation_review_disputes, review_digests
  FROM ventas_app, ventas_auth, PUBLIC;
--> statement-breakpoint
-- Métricas: las recalcula el código (upsert). Nunca cambian la conversación, la empresa ni el número.
GRANT SELECT, INSERT ON conversation_metrics TO ventas_app;
--> statement-breakpoint
GRANT UPDATE (opened_at, first_inbound_at, first_human_reply_at, handed_off_at,
  first_human_reply_after_handoff_at, first_response_seconds_business, handoff_response_seconds_business,
  human_messages_count, ai_messages_count, inbound_count, human_participated, unanswered, lead_tier_peak,
  closed_at, close_outcome, attributed_user_id, attribution) ON conversation_metrics TO ventas_app;
--> statement-breakpoint
-- Revisiones, disputas y resúmenes son registro: ni se editan ni se borran.
GRANT SELECT, INSERT ON conversation_reviews, conversation_review_disputes, review_digests TO ventas_app;
--> statement-breakpoint

-- 4. RLS por empresa -----------------------------------------------------------------------------------
ALTER TABLE conversation_metrics ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_metrics FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_review_disputes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_review_disputes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE review_digests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE review_digests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_metrics TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_reviews TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_review_disputes TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON review_digests TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- 5. Visibilidad por número (mismo criterio que 0015) ---------------------------------------------------
CREATE POLICY channel_visibility ON conversation_metrics AS RESTRICTIVE TO ventas_app
  USING ((SELECT app_sees_all_channels()) OR channel_id IN (SELECT app_visible_channel_ids()));
--> statement-breakpoint
CREATE POLICY channel_visibility ON conversation_reviews AS RESTRICTIVE TO ventas_app
  USING ((SELECT app_sees_all_channels()) OR channel_id IN (SELECT app_visible_channel_ids()));
--> statement-breakpoint
CREATE POLICY channel_visibility ON review_digests AS RESTRICTIVE TO ventas_app
  USING ((SELECT app_sees_all_channels()) OR channel_id IN (SELECT app_visible_channel_ids()));
--> statement-breakpoint
-- La disputa vale si su revisión es visible (la subconsulta aplica la RLS de conversation_reviews).
CREATE POLICY channel_visibility ON conversation_review_disputes AS RESTRICTIVE TO ventas_app
  USING (EXISTS (SELECT 1 FROM conversation_reviews r WHERE r.id = conversation_review_disputes.review_id));
--> statement-breakpoint

-- 6. Revisiones: solo owner y admin ---------------------------------------------------------------------
-- El control principal es el permiso performance.read_detail (libs/shared). Esto es la red de seguridad:
-- si un endpoint se equivoca, un seller o un viewer igual no lee revisiones ni resúmenes.
-- Sin app.user_id (workers y scripts) se ve todo, como en app_sees_all_channels().
CREATE FUNCTION app_reads_reviews() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT public.app_user_id() IS NULL OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.tenant_id = public.app_tenant_id()
        AND m.user_id = public.app_user_id()
        AND m.status = 'active'
        AND m.role IN ('owner', 'admin')
    )
  $$;
--> statement-breakpoint
-- Empresas activas, para el trabajo diario (cierre automático y analista). Solo ids, y solo fuera de un
-- request: con app.user_id o app.tenant_id seteados no devuelve nada.
CREATE FUNCTION active_tenant_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT t.id FROM public.tenants t
    WHERE t.status = 'active' AND public.app_user_id() IS NULL AND public.app_tenant_id() IS NULL
    ORDER BY t.id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_reads_reviews(), active_tenant_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_reads_reviews(), active_tenant_ids() TO ventas_app;
--> statement-breakpoint
CREATE POLICY owner_admin_only ON conversation_reviews AS RESTRICTIVE TO ventas_app
  USING ((SELECT app_reads_reviews())) WITH CHECK ((SELECT app_reads_reviews()));
--> statement-breakpoint
CREATE POLICY owner_admin_only ON conversation_review_disputes AS RESTRICTIVE TO ventas_app
  USING ((SELECT app_reads_reviews())) WITH CHECK ((SELECT app_reads_reviews()));
--> statement-breakpoint
CREATE POLICY owner_admin_only ON review_digests AS RESTRICTIVE TO ventas_app
  USING ((SELECT app_reads_reviews())) WITH CHECK ((SELECT app_reads_reviews()));
--> statement-breakpoint

-- 7. Colas del trabajo diario ---------------------------------------------------------------------------
-- performance-daily: un trabajo por día para todo el sistema (lo encola cada instancia de la API cada hora
-- con singletonSeconds = 86400; el índice job_i4 descarta los repetidos del mismo día). Reparte un trabajo
-- por empresa en performance-tenant. deleteAfterSeconds de 2 días: la fila del día tiene que seguir
-- existiendo para que el throttle descarte los repetidos.
SELECT pgboss.create_queue('performance-daily', '{
  "policy": "standard",
  "retryLimit": 2,
  "retryDelay": 300,
  "expireInSeconds": 300,
  "retentionSeconds": 172800,
  "deleteAfterSeconds": 172800
}'::jsonb);
--> statement-breakpoint
-- performance-tenant: por empresa (singletonKey = tenant_id), como mucho uno esperando y uno activo.
-- Cierre automático, revisiones (hasta review.max_per_day, una llamada al modelo por conversación) y el
-- resumen semanal. Solo el id de la empresa en el trabajo.
SELECT pgboss.create_queue('performance-tenant', '{
  "policy": "stately",
  "retryLimit": 1,
  "retryDelay": 600,
  "expireInSeconds": 3600,
  "retentionSeconds": 86400,
  "deleteAfterSeconds": 86400
}'::jsonb);
