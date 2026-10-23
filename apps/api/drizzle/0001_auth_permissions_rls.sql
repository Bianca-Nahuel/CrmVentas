-- Permisos y RLS de las tablas de autenticación y empresas.
-- Spec: docs/specs/autenticacion.md, "Usuarios de base y RLS".
--
-- Por qué tres usuarios: Better Auth tiene que leer sus tablas ANTES de conocer la empresa (buscar por
-- email, validar el token de sesión), así que no puede ir con RLS por tenant. Para que un bug del código
-- de negocio nunca pueda leer contraseñas ni sesiones, Better Auth usa su propio rol (ventas_auth) y el
-- resto del backend usa ventas_app, que no tiene ningún permiso sobre accounts/sessions/verifications.
--
-- Las 7 tablas tienen RLS con ENABLE + FORCE. ventas_auth no tiene BYPASSRLS, así que necesita una
-- política propia que le permita todo (si no, con RLS forzada vería 0 filas). ventas_app solo ve lo que
-- le permiten sus políticas, según app.user_id / app.tenant_id (SET LOCAL en cada request).

-- 1. Helpers de contexto ----------------------------------------------------------------------------
-- nullif: después de un SET LOCAL, una conexión reutilizada del pool devuelve '' (no NULL) y el cast
-- a uuid fallaría. Sin contexto → NULL → ninguna fila pasa las políticas.
CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

-- Empresas donde el usuario del contexto tiene membresía ACTIVA.
-- SECURITY DEFINER: las políticas de tenants y users necesitan mirar memberships sin que la RLS de
-- memberships esconda a los compañeros de otras empresas. Corre como el dueño (ventas_owner, superusuario
-- en el contenedor, por eso no le aplica la RLS forzada; en un entorno donde el dueño no sea superusuario
-- necesita BYPASSRLS). search_path fijo para que no se pueda secuestrar con objetos de otro schema.
CREATE FUNCTION app_user_tenant_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT m.tenant_id
    FROM public.memberships m
    WHERE m.user_id = public.app_user_id() AND m.status = 'active'
  $$;
--> statement-breakpoint

-- Usuarios que comparten alguna empresa con el usuario del contexto (contando solo SUS membresías activas;
-- los compañeros se ven aunque estén desactivados, para poder reactivarlos).
CREATE FUNCTION app_visible_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT DISTINCT other.user_id
    FROM public.memberships mine
    JOIN public.memberships other ON other.tenant_id = mine.tenant_id
    WHERE mine.user_id = public.app_user_id() AND mine.status = 'active'
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_tenant_ids(), app_visible_user_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_tenant_ids(), app_visible_user_ids() TO ventas_app;
--> statement-breakpoint

-- 2. updated_at (trigger compartido; lo reutilizan las tablas de negocio) ---------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER verifications_set_updated_at BEFORE UPDATE ON verifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER memberships_set_updated_at BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- 3. Privilegios ------------------------------------------------------------------------------------
-- Los default privileges de infra/postgres/init/01-init.sh le dan DML a ventas_app sobre TODA tabla
-- nueva de public. Acá no sirve: primero se revoca todo y después se da solo lo de la spec.
REVOKE ALL ON users, sessions, accounts, verifications, tenants, memberships, invitations FROM ventas_app, PUBLIC;
--> statement-breakpoint

-- ventas_auth: DML sobre las tablas de autenticación y nada más (sin default privileges: no recibe
-- nada de las tablas de negocio que se creen después).
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, accounts, verifications, tenants, memberships, invitations TO ventas_auth;
--> statement-breakpoint

-- ventas_app: nada sobre accounts/sessions/verifications.
GRANT SELECT (id, name, email, image) ON users TO ventas_app;
--> statement-breakpoint
GRANT SELECT ON tenants TO ventas_app;
--> statement-breakpoint
GRANT UPDATE (name, logo, industry, timezone) ON tenants TO ventas_app;
--> statement-breakpoint
GRANT SELECT ON memberships TO ventas_app;
--> statement-breakpoint
-- Solo owner/admin pueden cambiar estado o rol: se valida en los servicios.
GRANT UPDATE (status, role) ON memberships TO ventas_app;
--> statement-breakpoint
GRANT SELECT ON invitations TO ventas_app;
--> statement-breakpoint

-- 4. RLS ----------------------------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE verifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE verifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ventas_auth (solo Better Auth) ve y modifica todo en sus tablas.
CREATE POLICY auth_full_access ON users TO ventas_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_full_access ON sessions TO ventas_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_full_access ON accounts TO ventas_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_full_access ON verifications TO ventas_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_full_access ON tenants TO ventas_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_full_access ON memberships TO ventas_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_full_access ON invitations TO ventas_auth USING (true) WITH CHECK (true);
--> statement-breakpoint

-- accounts, sessions, verifications: ninguna política para ventas_app → aunque alguien le diera un
-- grant por error, vería 0 filas.

-- users: el propio usuario y los que comparten alguna empresa con él.
CREATE POLICY app_select ON users FOR SELECT TO ventas_app
  USING (id = app_user_id() OR id IN (SELECT app_visible_user_ids()));
--> statement-breakpoint

-- tenants: las empresas donde el usuario tiene membresía activa; solo se edita la empresa activa.
CREATE POLICY app_select ON tenants FOR SELECT TO ventas_app
  USING (id IN (SELECT app_user_tenant_ids()));
--> statement-breakpoint
CREATE POLICY app_update ON tenants FOR UPDATE TO ventas_app
  USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
--> statement-breakpoint

-- memberships: las propias (para elegir empresa) y las de la empresa activa.
CREATE POLICY app_select ON memberships FOR SELECT TO ventas_app
  USING (user_id = app_user_id() OR tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY app_update ON memberships FOR UPDATE TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- invitations: las de la empresa activa.
CREATE POLICY app_select ON invitations FOR SELECT TO ventas_app
  USING (tenant_id = app_tenant_id());
