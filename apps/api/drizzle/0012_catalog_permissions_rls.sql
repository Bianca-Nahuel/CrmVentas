-- Búsqueda, FKs entre empresas, permisos, RLS y cola del catálogo (tarea 007). Las tablas y sus CHECKs
-- están en 0011 (generada desde apps/api/src/db/schema/catalog.ts). Las extensiones unaccent y pg_trgm
-- las crea infra/postgres/init/01-init.sh.

-- 1. Búsqueda ---------------------------------------------------------------------------------------------
-- unaccent() no es IMMUTABLE (depende del diccionario de la sesión): con el diccionario explícito sí lo
-- es, y así puede usarse en una columna generada y en un índice.
CREATE FUNCTION catalog_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN public.unaccent('public.unaccent'::regdictionary, $1);
--> statement-breakpoint
-- Los valores de texto (y números) de attributes, para la búsqueda. Nunca las claves.
CREATE FUNCTION catalog_attributes_text(jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN (SELECT coalesce(string_agg(value, ' '), '') FROM jsonb_each_text($1)
          WHERE jsonb_typeof($1 -> key) IN ('string', 'number'));
--> statement-breakpoint
ALTER TABLE catalog_products ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('spanish'::regconfig, catalog_unaccent(lower(name))), 'A')
  || setweight(to_tsvector('spanish'::regconfig, catalog_unaccent(lower(coalesce(category, '')))), 'B')
  || setweight(to_tsvector('spanish'::regconfig, catalog_unaccent(lower(catalog_attributes_text(attributes)))), 'C')
) STORED;
--> statement-breakpoint
CREATE INDEX catalog_products_search_idx ON catalog_products USING gin (search_tsv);
--> statement-breakpoint
-- Errores de tipeo: trigramas sobre el nombre sin tildes.
CREATE INDEX catalog_products_name_trgm_idx ON catalog_products
  USING gin (catalog_unaccent(lower(name)) gin_trgm_ops);
--> statement-breakpoint
-- Último snapshot válido de un producto (caché y controles de cordura).
CREATE INDEX product_snapshots_ok_idx ON product_snapshots (product_id, source, read_at DESC) WHERE ok;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION catalog_unaccent(text), catalog_attributes_text(jsonb) TO ventas_app;
--> statement-breakpoint

-- 2. FKs con tenant_id (mismo criterio que 0003): nada apunta a una fila de otra empresa -----------------
ALTER TABLE catalog_products ADD CONSTRAINT catalog_products_last_import_fk
  FOREIGN KEY (tenant_id, last_import_id) REFERENCES catalog_imports (tenant_id, id)
  ON DELETE SET NULL (last_import_id);
--> statement-breakpoint
ALTER TABLE catalog_imports ADD CONSTRAINT catalog_imports_base_import_fk
  FOREIGN KEY (tenant_id, base_import_id) REFERENCES catalog_imports (tenant_id, id)
  ON DELETE SET NULL (base_import_id);
--> statement-breakpoint
-- Quien hizo la importación es miembro de la empresa. NULL si la hizo un script.
ALTER TABLE catalog_imports ADD CONSTRAINT catalog_imports_created_by_fk
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, user_id)
  ON DELETE SET NULL (created_by);
--> statement-breakpoint
ALTER TABLE catalog_import_rows ADD CONSTRAINT catalog_import_rows_import_fk
  FOREIGN KEY (tenant_id, import_id) REFERENCES catalog_imports (tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE product_snapshots ADD CONSTRAINT product_snapshots_product_fk
  FOREIGN KEY (tenant_id, product_id) REFERENCES catalog_products (tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE product_snapshots ADD CONSTRAINT product_snapshots_import_fk
  FOREIGN KEY (tenant_id, import_id) REFERENCES catalog_imports (tenant_id, id)
  ON DELETE SET NULL (import_id);
--> statement-breakpoint

-- 3. updated_at (trigger compartido de 0001) ------------------------------------------------------------
CREATE TRIGGER catalog_products_set_updated_at BEFORE UPDATE ON catalog_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- 4. Privilegios ----------------------------------------------------------------------------------------
-- Los default privileges le dan DML completo a ventas_app: se revoca y se da lo justo. ventas_auth nada.
-- Ninguna tiene DELETE: un producto ausente del Excel se desactiva, y el resto es historial.
REVOKE ALL ON catalog_products, catalog_imports, catalog_import_rows, product_snapshots
  FROM ventas_app, ventas_auth, PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON catalog_products, catalog_imports, catalog_import_rows, product_snapshots
  TO ventas_app;
--> statement-breakpoint
-- Al aplicar o volver atrás una importación: los datos del producto y si está activo. Nunca la empresa,
-- el id ni el SKU (un SKU distinto es otro producto).
GRANT UPDATE (name, category, unit, units_per_package, pieces_per_package, url, attributes, active,
  last_import_id, updated_at) ON catalog_products TO ventas_app;
--> statement-breakpoint
GRANT UPDATE (status, applied_at, reverted_at, error_code) ON catalog_imports TO ventas_app;
--> statement-breakpoint

-- 5. RLS --------------------------------------------------------------------------------------------------
ALTER TABLE catalog_products ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_products FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_imports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_import_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_import_rows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE product_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE product_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON catalog_products TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON catalog_imports TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON catalog_import_rows TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON product_snapshots TO ventas_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- 6. Cola del refresco de precios ------------------------------------------------------------------------
-- Un trabajo por empresa (singletonKey = tenant_id) que se vuelve a encolar solo cada hora al terminar.
-- policy stately: como mucho uno esperando y uno activo por empresa. Los trabajos llevan solo el id.
-- expireInSeconds 300: hasta 30 productos a 1 pedido por segundo con timeout de 8 s cada uno.
SELECT pgboss.create_queue('catalog-refresh', '{
  "policy": "stately",
  "retryLimit": 1,
  "retryDelay": 60,
  "expireInSeconds": 300,
  "retentionSeconds": 86400,
  "deleteAfterSeconds": 86400
}'::jsonb);
