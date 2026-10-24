-- Más margen de reintentos para whatsapp-inbound (revisión de la tarea 004).
-- Con retryLimit 5 los reintentos se agotaban en ~2,5 min (5, 10, 20, 40, 80 s): una caída corta de
-- Postgres o de WAHA perdía mensajes a los que WAHA ya les había recibido el 200. Con 10 y techo de
-- 5 min cubren ~25 min (5, 10, 20, 40, 80, 160, 300, 300, 300, 300 s). El worker registra el último
-- intento fallido como "fallido" (sin datos personales).
-- Solo cambia la configuración de la cola; los trabajos ya encolados conservan la suya.
UPDATE pgboss.queue
SET retry_limit = 10,
    retry_delay_max = 300,
    updated_on = now()
WHERE name = 'whatsapp-inbound';
