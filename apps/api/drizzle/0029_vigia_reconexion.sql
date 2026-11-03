-- Vigía de reconexión de los números (channel-watch). Si la API o WAHA se reinician y se pierde el webhook
-- WORKING, el canal quedaba en "Reconectando" para siempre: cada minuto el trabajo mira en el proveedor los
-- canales no conectados que ya tuvieron número y los sincroniza o reinicia la sesión (sin QR).
-- Un trabajo por minuto para todo el sistema: cada instancia de la API lo encola con singletonSeconds = 60.
SELECT pgboss.create_queue('whatsapp-channel-watch', '{
  "policy": "standard",
  "retryLimit": 0,
  "expireInSeconds": 120,
  "retentionSeconds": 600,
  "deleteAfterSeconds": 600
}'::jsonb);
