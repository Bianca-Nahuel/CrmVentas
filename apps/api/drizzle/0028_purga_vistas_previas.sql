-- La purga de la tarea 027 también borra las vistas previas abandonadas (lo marcó revisor-codigo): cada
-- subida desde el panel crea una importación en preview con hasta 10.000 filas, y sin esto quedaban para
-- siempre. Una vista previa de más de 24 h ya no se puede rehacer (su archivo venció), así que se borra con
-- sus filas y su archivo (ON DELETE CASCADE de 0012 y 0027). Nunca toca una importación aplicada, revertida o
-- fallida: son el historial. Mismo criterio de SECURITY DEFINER que en 0027; la firma no cambia, así que el
-- GRANT a ventas_app se conserva.
CREATE OR REPLACE FUNCTION purge_expired_catalog_import_files() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    deleted integer;
  BEGIN
    IF public.app_tenant_id() IS NOT NULL OR public.app_user_id() IS NOT NULL THEN
      RETURN 0;
    END IF;
    DELETE FROM public.catalog_imports
      WHERE status = 'preview' AND created_at < now() - interval '24 hours';
    DELETE FROM public.catalog_import_files WHERE expires_at < now();
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
  END
  $$;
