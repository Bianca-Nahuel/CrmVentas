-- Tarea 026 (revisión de seguridad): la política de 0023 sumó al viewer en conversation_metrics sin FOR, así
-- que también valía para INSERT y UPDATE. Se separa: la lectura de los totales incluye al viewer; las
-- escrituras (las hacen los workers y el cierre) quedan con la visibilidad de siempre (0015/0022).
DROP POLICY channel_visibility ON conversation_metrics;
--> statement-breakpoint
CREATE POLICY channel_visibility_read ON conversation_metrics AS RESTRICTIVE FOR SELECT TO ventas_app
  USING (
    (SELECT app_sees_all_channels())
    OR (SELECT app_reads_performance_totals())
    OR channel_id IN (SELECT app_visible_channel_ids())
  );
--> statement-breakpoint
CREATE POLICY channel_visibility_insert ON conversation_metrics AS RESTRICTIVE FOR INSERT TO ventas_app
  WITH CHECK ((SELECT app_sees_all_channels()) OR channel_id IN (SELECT app_visible_channel_ids()));
--> statement-breakpoint
CREATE POLICY channel_visibility_update ON conversation_metrics AS RESTRICTIVE FOR UPDATE TO ventas_app
  USING ((SELECT app_sees_all_channels()) OR channel_id IN (SELECT app_visible_channel_ids()))
  WITH CHECK ((SELECT app_sees_all_channels()) OR channel_id IN (SELECT app_visible_channel_ids()));
