---
name: webhook-whatsapp
description: Convenciones para recibir y enviar mensajes de WhatsApp (WAHA y Cloud API de Meta) a través de la interfaz WhatsAppProvider. Usar en cualquier tarea que toque webhooks, envío de mensajes o proveedores de WhatsApp.
---

# WhatsApp: proveedores, webhooks y envío

## Arquitectura
- `apps/api/src/whatsapp/providers/`: una implementación por proveedor (`WahaProvider`, `CloudApiProvider`) de la interfaz `WhatsAppProvider`. **Solo acá** se conoce el formato de cada proveedor.
- Cada proveedor traduce su payload a eventos normalizados: `message.received`, `message.sent_by_agent` (el vendedor respondió desde el celular), `message.status`, `session.status`.
- Lo que cambia entre proveedores se expresa en `capabilities` (`templates`, `within24hWindowOnly`, `adAttribution`, `outboundCampaigns`), nunca con `if (provider === ...)` fuera de `providers/`.

## Recepción (webhook)
1. Verificar autenticidad: WAHA con API key/HMAC; Meta con `X-Hub-Signature-256` sobre el body crudo.
2. Responder **200 inmediatamente** y encolar el procesamiento (pg-boss). Nunca llamar a la IA dentro del request.
3. En el job: normalizar → buscar el canal por `external_id` → setear el tenant → upsert de contacto y conversación → insertar el mensaje con `ON CONFLICT (channel_id, external_id) DO NOTHING` → guardar el payload crudo en `raw`.
4. Mensajes propios (WAHA `fromMe` / evento `message.any`; Meta `smb_message_echoes`) = `sender_type = 'app'`. Setean `conversations.ai_paused_until` para que la IA no responda encima del vendedor.
5. Nunca loguear teléfonos ni texto de mensajes.

## Envío
- Antes de enviar: ¿la conversación tiene `ai_paused_until` vigente? ¿el lead es caliente? En esos casos la IA no envía.
- Conexión no oficial (WAHA): solo responder, nunca iniciar conversaciones. Secuencia: marcar visto → "escribiendo…" → demora aleatoria proporcional al largo → dejar de escribir → enviar. Un solo mensaje bien armado en vez de varias burbujas.
- Errores 463 (restricción por contactos nuevos) y 475 (cuota del ciclo): pausar envíos de ese canal, registrar y alertar. **No** reiniciar ni re-vincular la sesión.
- Conexión oficial (Cloud API): fuera de la ventana de 24 h (`last_inbound_at`), solo plantillas aprobadas. Registrar `cost_usd` por mensaje.

## Tests
- Fixtures con payloads reales de cada proveedor (anonimizados) en `apps/api/test/fixtures/whatsapp/`.
- Probar: webhook duplicado → un solo mensaje; firma inválida → 401 y nada guardado; mensaje propio → pausa la IA; mismo flujo de negocio con payload de WAHA y de Cloud API.
