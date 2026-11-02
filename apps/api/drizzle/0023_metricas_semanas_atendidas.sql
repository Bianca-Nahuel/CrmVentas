-- Tarea 026: "atendidas" por semana sale de conversation_metrics (human_reply_weeks) y no de messages, así
-- el viewer ve los totales por número sin poder leer mensajes ni conversaciones. El índice parcial de
-- messages que se había creado para esa consulta en 0021 ya no se usa.
DROP INDEX "messages_human_channel_sent_at_idx";--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "human_reply_weeks" date[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
GRANT UPDATE (human_reply_weeks) ON conversation_metrics TO ventas_app;
--> statement-breakpoint

-- Quién ve los totales de Rendimiento de todos los números: los que tienen performance.read en libs/shared
-- (owner, admin y viewer; un test compara las dos definiciones). Sin app.user_id (workers) también.
CREATE FUNCTION app_reads_performance_totals() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT public.app_user_id() IS NULL OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.tenant_id = public.app_tenant_id()
        AND m.user_id = public.app_user_id()
        AND m.status = 'active'
        AND m.role IN ('owner', 'admin', 'viewer')
    )
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_reads_performance_totals() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_reads_performance_totals() TO ventas_app;
--> statement-breakpoint
-- Solo conversation_metrics: conversaciones, mensajes y revisiones siguen con su visibilidad de siempre.
DROP POLICY channel_visibility ON conversation_metrics;
--> statement-breakpoint
CREATE POLICY channel_visibility ON conversation_metrics AS RESTRICTIVE TO ventas_app
  USING (
    (SELECT app_sees_all_channels())
    OR (SELECT app_reads_performance_totals())
    OR channel_id IN (SELECT app_visible_channel_ids())
  );
