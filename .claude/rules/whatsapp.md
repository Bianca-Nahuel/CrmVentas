---
paths: ["apps/api/src/whatsapp/**", "apps/api/src/messaging/**"]
---
- Seguí el skill `webhook-whatsapp`.
- Solo `providers/` conoce el formato de WAHA o de Meta; el resto usa eventos normalizados y `capabilities`.
- Webhook: autenticar → 200 inmediato → cola → idempotencia por `(channel_id, external_id)`.
- Conexión no oficial: nunca iniciar conversaciones ni campañas.
