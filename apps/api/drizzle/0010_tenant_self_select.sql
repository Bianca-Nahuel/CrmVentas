-- Los workers (cola ai-reply, tarea 006) corren con app.tenant_id y sin app.user_id: la política
-- app_select de 0001 (empresas del usuario) no les deja ver ni la empresa en la que trabajan, y el agente
-- necesita su zona horaria. Esta política suma (OR) la lectura de la empresa activa y nada más.
-- app.tenant_id lo setean solo el TenantGuard (después de validar la membresía) y los workers (con la
-- empresa de resolve_channel o del trabajo), nunca un dato del cliente.
CREATE POLICY app_select_active ON tenants FOR SELECT TO ventas_app
  USING (id = app_tenant_id());
