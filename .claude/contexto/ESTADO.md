# Estado del proyecto

_Última actualización: 2026-10-23_

## Hecho

- Tarea 003: tablas `channels`, `contacts`, `conversations`, `messages` (migraciones 0002 generada + 0003 a mano) con RLS forzada, grants mínimos por columna, FKs compuestas entre empresas (también a `memberships` para usuarios asignados) y `resolve_channel()` para el webhook. Seed con un canal y una conversación por empresa demo. 63 tests. Aprobada por los dos revisores en la primera ronda. **Sin commitear.**
- La API ya no exige `DATABASE_URL_MIGRATIONS` al arrancar: solo la leen drizzle-kit y los tests.
- Tarea 002: backend NestJS 12 (ESM) en `apps/api` con Better Auth 1.7.12 (email + contraseña, organizaciones, admin sin suplantación), tablas `users`/`sessions`/`accounts`/`verifications`/`tenants`/`memberships`/`invitations` con RLS, tres usuarios de base (`ventas_owner`, `ventas_auth`, `ventas_app`), `TenantGuard` + transacción por request con `SET LOCAL`, seed y 27 tests e2e. Aprobada por los dos revisores (ronda 2). Commiteada (67b52bf).
- Tarea 001: entorno de desarrollo (Postgres 18 + WAHA en Docker Compose, verificación completa).
- Tarea 000: proyecto ordenado y configuración del agente instalada. Aprobada por `revisor-codigo` y `revisor-seguridad`.

## En curso

- (nada)

## Siguiente

- Commit de la tarea 003 (lo confirma el usuario).
- Tarea 004: webhook de WAHA → cola (pg-boss) → guardado del mensaje. Leer antes "Deuda pendiente (tarea 003)" en `docs/decisiones.md` (`external_id` nunca desde el cliente, `risk_accepted_by` desde `app.user_id`) y definir el formato de `contacts.wa_id` (LIDs).
- Tarea de endurecimiento de seguridad: ver las dos secciones de "Deuda de seguridad pendiente" en `docs/decisiones.md` (rate limit detrás de Caddy, políticas de UPDATE por rol, `REVOKE TEMPORARY`, logger sin PII, `AuthService` global, etc.).

## Bloqueos / pendientes externos

- Trámite de Tech Provider en Meta (para la API oficial): no iniciado.
- En otra máquina con un volumen de Postgres viejo hay que crear `ventas_auth` a mano (comando en `docs/entorno-dev.md`).
