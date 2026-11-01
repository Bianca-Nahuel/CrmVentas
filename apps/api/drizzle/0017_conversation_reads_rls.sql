-- Permisos y RLS de conversation_reads ("sin ver" por persona en la bandeja). La tabla está en 0016.

-- 1. El usuario es miembro de la empresa de la conversación. Si se borra la membresía, se borran sus lecturas.
ALTER TABLE conversation_reads ADD CONSTRAINT conversation_reads_user_fk
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE;
--> statement-breakpoint

-- 2. Privilegios: solo se inserta o se corre la fecha hacia adelante. Sin DELETE.
REVOKE ALL ON conversation_reads FROM ventas_app, ventas_auth, PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON conversation_reads TO ventas_app;
--> statement-breakpoint
GRANT UPDATE (last_read_at) ON conversation_reads TO ventas_app;
--> statement-breakpoint

-- 3. RLS: la empresa activa y, además, solo las filas del usuario del contexto (lo que vio otro no se ve ni
-- se toca). Sin app.user_id (workers) no pasa ninguna fila: ningún trabajo de la cola usa esta tabla.
ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_reads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_reads ON conversation_reads TO ventas_app
  USING (tenant_id = app_tenant_id() AND user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id() AND user_id = app_user_id());
--> statement-breakpoint
-- Misma red de seguridad por número que conversation_events (0015).
CREATE POLICY channel_visibility ON conversation_reads AS RESTRICTIVE TO ventas_app
  USING (
    (SELECT app_sees_all_channels())
    OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_reads.conversation_id)
  );
