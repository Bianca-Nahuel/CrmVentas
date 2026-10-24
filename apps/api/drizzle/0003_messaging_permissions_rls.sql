-- Permisos, RLS y función del webhook para las tablas de mensajería (tarea 003).
-- Las tablas, CHECKs, UNIQUEs y FKs compuestas entre ellas están en 0002 (generada desde
-- apps/api/src/db/schema/messaging.ts). Acá va lo que Drizzle no expresa.

-- 1. FKs a usuarios de la MISMA empresa ---------------------------------------------------------------
-- Una FK simple a users dejaría asignar una conversación a un usuario de otra empresa. Apuntando a
-- memberships (tenant_id, user_id), el usuario tiene que ser miembro de la empresa de la fila.
-- SET NULL (columna): al borrar la membresía (o el usuario, que la borra en cascada) se anula solo la
-- columna del usuario, no el tenant_id (que es NOT NULL y forma parte de la clave).
-- risk_accepted_by sigue apuntando a users con RESTRICT (en 0002): es el registro de quién aceptó el
-- riesgo de la conexión no oficial y el CHECK lo exige mientras el canal exista.
ALTER TABLE channels ADD CONSTRAINT channels_default_user_fk
  FOREIGN KEY (tenant_id, default_user_id) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (default_user_id);
--> statement-breakpoint
ALTER TABLE conversations ADD CONSTRAINT conversations_assigned_user_fk
  FOREIGN KEY (tenant_id, assigned_user_id) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (assigned_user_id);
--> statement-breakpoint
ALTER TABLE messages ADD CONSTRAINT messages_sent_by_user_fk
  FOREIGN KEY (tenant_id, sent_by_user_id) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (sent_by_user_id);
--> statement-breakpoint

-- 2. updated_at (trigger compartido de 0001). messages no tiene updated_at. ---------------------------
CREATE TRIGGER channels_set_updated_at BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- 3. Privilegios --------------------------------------------------------------------------------------
-- Los default privileges de infra/postgres/init/01-init.sh le dan DML completo a ventas_app sobre toda
-- tabla nueva: se revoca todo y se da exactamente lo de la tarea. ventas_auth (Better Auth) no recibe
-- nada: no tiene por qué leer mensajes de clientes.
REVOKE ALL ON channels, contacts, conversations, messages FROM ventas_app, ventas_auth, PUBLIC;
--> statement-breakpoint

-- Sin DELETE en ninguna: canales, contactos y conversaciones se desactivan o archivan; los mensajes son
-- el historial. Un borrado real (baja de una empresa) lo hace la cascada desde tenants, como dueño.
GRANT SELECT, INSERT ON channels, contacts, conversations, messages TO ventas_app;
--> statement-breakpoint

-- UPDATE por columnas: nunca id, tenant_id ni created_at (la identidad y la empresa de una fila no
-- cambian; la política ya impide mover una fila a otra empresa, esto lo hace imposible por permisos).
-- updated_at tampoco: lo pone el trigger.
GRANT UPDATE (name, phone_number, provider, connection_type, external_id, status, default_user_id,
  risk_accepted_at, risk_accepted_by, provider_config) ON channels TO ventas_app;
--> statement-breakpoint
GRANT UPDATE (wa_id, profile_name, display_name, marketing_opt_in, opt_in_at, blocked, first_seen_at,
  last_seen_at) ON contacts TO ventas_app;
--> statement-breakpoint
GRANT UPDATE (channel_id, contact_id, status, inbox, assigned_user_id, ai_paused_until, last_message_at,
  last_inbound_at) ON conversations TO ventas_app;
--> statement-breakpoint
-- Un mensaje no se edita: solo cambia su estado de entrega y, para la API oficial, su costo.
GRANT UPDATE (status, cost_usd) ON messages TO ventas_app;
--> statement-breakpoint

-- 4. RLS ------------------------------------------------------------------------------------------------
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE channels FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Solo la empresa activa (app.tenant_id). Sin contexto app_tenant_id() es NULL y no pasa ninguna fila.
-- Que un seller vea solo lo suyo NO va acá: se resuelve en los servicios.
-- ventas_auth no tiene política: aunque alguien le diera un grant por error, vería 0 filas.
CREATE POLICY tenant_isolation ON channels TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON contacts TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversations TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON messages TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- 5. resolve_channel ------------------------------------------------------------------------------------
-- El webhook recibe un mensaje sin saber de qué empresa es: con el proveedor y el external_id (sesión
-- de WAHA o phone_number_id de Meta) obtiene el canal y la empresa, y recién ahí setea app.tenant_id.
-- Devuelve SOLO esos dos campos, y nada si el canal está banned o la empresa no está activa.
-- SECURITY DEFINER: corre como el dueño, mismo criterio que los helpers de 0001 (superusuario en el
-- contenedor; en producción, rol sin login con BYPASSRLS, ver docs/decisiones.md). search_path fijo y
-- nombres calificados para que no se pueda secuestrar con objetos de otro schema.
CREATE FUNCTION resolve_channel(p_provider text, p_external_id text)
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
      AND t.status = 'active'
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_channel(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_channel(text, text) TO ventas_app;
