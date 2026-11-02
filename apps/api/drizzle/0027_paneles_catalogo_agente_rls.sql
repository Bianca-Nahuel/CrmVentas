-- Permisos, RLS y cola de los paneles de catálogo y del agente (tarea 027). Las tablas están en 0026
-- (generada desde apps/api/src/db/schema/catalog.ts y ai.ts).

-- 1. FKs con tenant_id (mismo criterio que 0003) ---------------------------------------------------------
-- El archivo es de una importación de la MISMA empresa; si se borra la importación, se borra el archivo.
ALTER TABLE catalog_import_files ADD CONSTRAINT catalog_import_files_import_fk
  FOREIGN KEY (tenant_id, import_id) REFERENCES catalog_imports (tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ai_playground_runs ADD CONSTRAINT ai_playground_runs_user_fk
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (user_id);
--> statement-breakpoint

-- 2. Privilegios ----------------------------------------------------------------------------------------
-- Los default privileges le dan DML completo a ventas_app: se revoca y se da lo justo. ventas_auth nada.
-- Los archivos vencidos los borra purge_expired_catalog_import_files() (punto 5), no la app.
REVOKE ALL ON catalog_import_files, ai_playground_runs FROM ventas_app, ventas_auth, PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON catalog_import_files, ai_playground_runs TO ventas_app;
--> statement-breakpoint
-- Rehacer la vista previa con otro mapeo sobre la misma importación: su hoja, su mapeo, la base y los
-- conteos. Nunca la empresa, el archivo ni el estado (eso sigue siendo solo de 0012).
GRANT UPDATE (sheet_name, mapping, base_import_id, rows_total, rows_invalid, new_count, changed_count,
  unchanged_count, missing_count, price_jump_count) ON catalog_imports TO ventas_app;
--> statement-breakpoint
-- ... y reemplazar sus filas (la política del punto 4 lo limita a importaciones en vista previa).
GRANT DELETE ON catalog_import_rows TO ventas_app;
--> statement-breakpoint

-- 3. RLS por empresa -----------------------------------------------------------------------------------
ALTER TABLE catalog_import_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_import_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_playground_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_playground_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON catalog_import_files TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_playground_runs TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- 4. Filas de una importación: solo se borran mientras está en vista previa ---------------------------------
-- Las de una importación aplicada o revertida son el historial (y lo que reaplica "volver atrás").
CREATE POLICY preview_only_delete ON catalog_import_rows AS RESTRICTIVE FOR DELETE TO ventas_app
  USING (EXISTS (
    SELECT 1 FROM catalog_imports i
    WHERE i.id = catalog_import_rows.import_id AND i.status = 'preview'
  ));
--> statement-breakpoint

-- 5. Borrado de los archivos vencidos -------------------------------------------------------------------
-- La corre el trabajo catalog-import-files-purge, sin empresa activa. SECURITY DEFINER (mismo criterio que
-- resolve_channel en 0003): borra SOLO los vencidos de todas las empresas y devuelve cuántos. Dentro de un
-- request (con app.tenant_id o app.user_id) no hace nada.
CREATE FUNCTION purge_expired_catalog_import_files() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    deleted integer;
  BEGIN
    IF public.app_tenant_id() IS NOT NULL OR public.app_user_id() IS NOT NULL THEN
      RETURN 0;
    END IF;
    DELETE FROM public.catalog_import_files WHERE expires_at < now();
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_expired_catalog_import_files() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_catalog_import_files() TO ventas_app;
--> statement-breakpoint

-- 6. Cola ----------------------------------------------------------------------------------------------
-- Un trabajo por hora para todo el sistema: cada instancia de la API lo encola con singletonSeconds = 3600.
SELECT pgboss.create_queue('catalog-import-files-purge', '{
  "policy": "standard",
  "retryLimit": 2,
  "retryDelay": 300,
  "expireInSeconds": 300,
  "retentionSeconds": 7200,
  "deleteAfterSeconds": 7200
}'::jsonb);
