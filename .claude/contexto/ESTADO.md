# Estado del proyecto

_Última actualización: 2026-10-24_

## Hecho

- Tarea 005: envío por outbox `outbound_messages` (migraciones 0006/0007, cola `whatsapp-outbound` singleton por chat), worker visto → escribiendo → enviar (claim atómico, lock por canal, nunca reenvía un `sending`, 5xx/timeout = `unknown_outcome`), ecos por `message.any` (de una persona → `user` y la IA pausada 12 h), acuses por `message.ack`, `blocked_risk` pausa el canal sin vencimiento. Scripts `dev:send` y `dev:resume-channel`. Id canónico de WAHA `<fromMe>_<key.id>`; el visto va con los ids originales del `raw` (NOWEB sin store). Decisiones #28–#35 y deuda de la 005. 207 tests. Prueba real OK. Aprobada por los dos revisores. **Sin commitear.**
- Tarea 004: webhook `POST /api/webhooks/waha` con HMAC-SHA512 sobre el cuerpo crudo → cola pg-boss `whatsapp-inbound` (schema `pgboss` creado por `ventas_owner` en las migraciones 0004/0005, retención 24 h, 10 reintentos) → worker que guarda contacto, conversación y mensaje en la empresa del canal (idempotente, carrera resuelta con `ON CONFLICT`). Script `npm run dev:create-channel`. `infra/servicios.yml` sin webhook global y con la imagen fijada a `devlikeapro/waha:latest-2026.8.1`. Script `dev:sync-channel-webhook` para reaplicar el webhook sin reescanear. Prueba real OK (texto, fotos con epígrafe y audio; el remitente llegó como `@lid` con el número en `remoteJidAlt`). Decisiones #22–#27. 129 tests. Aprobada por los dos revisores (3 rondas). Commiteada (f125cc0).
- Tarea 003: tablas `channels`, `contacts`, `conversations`, `messages` (migraciones 0002 generada + 0003 a mano) con RLS forzada, grants mínimos por columna, FKs compuestas entre empresas (también a `memberships` para usuarios asignados) y `resolve_channel()` para el webhook. Seed con un canal y una conversación por empresa demo. 63 tests. Aprobada por los dos revisores en la primera ronda. Commiteada (cdc370b).
- La API ya no exige `DATABASE_URL_MIGRATIONS` al arrancar: solo la leen drizzle-kit y los tests.
- Tarea 002: backend NestJS 12 (ESM) en `apps/api` con Better Auth 1.7.12 (email + contraseña, organizaciones, admin sin suplantación), tablas `users`/`sessions`/`accounts`/`verifications`/`tenants`/`memberships`/`invitations` con RLS, tres usuarios de base (`ventas_owner`, `ventas_auth`, `ventas_app`), `TenantGuard` + transacción por request con `SET LOCAL`, seed y 27 tests e2e. Aprobada por los dos revisores (ronda 2). Commiteada (67b52bf).
- Tarea 001: entorno de desarrollo (Postgres 18 + WAHA en Docker Compose, verificación completa).
- Tarea 000: proyecto ordenado y configuración del agente instalada. Aprobada por `revisor-codigo` y `revisor-seguridad`.

## En curso

- (nada)

## Siguiente

- Commit de la tarea 005 (lo confirma el usuario).
- Tarea 006 (primera respuesta de la IA): encola con `OutboundService.enqueueText` (`senderType: 'ai'`) y tiene que respetar `conversations.ai_paused_until` antes de encolar; el envío por sí solo no lo mira (`dev:send` manda aunque la IA esté pausada).
- Antes de `npm run test`, bajar `npm run dev:api` (comparten la cola de pg-boss).
- Tarea 008 (alta de canales y QR desde el panel): el número del canal sale del escaneo del QR (`me.id` en `session.status` = `WORKING`), no de un parámetro. Leer antes la decisión #27 y "Para la tarea 008" en `docs/decisiones.md` (cambio de schema, re-escaneo con otro teléfono, número repetido).
- Tarea de endurecimiento de seguridad: ver las secciones de "Deuda de seguridad pendiente" y "Deuda pendiente" en `docs/decisiones.md` (rate limit detrás de Caddy, políticas de UPDATE por rol, `REVOKE TEMPORARY`, logger sin PII, `AuthService` global, replay de `session.status`, clave HMAC por canal, etc.).

## Bloqueos / pendientes externos

- Trámite de Tech Provider en Meta (para la API oficial): no iniciado.
- En otra máquina con un volumen de Postgres viejo hay que crear `ventas_auth` a mano (comando en `docs/entorno-dev.md`).
