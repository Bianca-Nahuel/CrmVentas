# Estado del proyecto

_Última actualización: 2026-10-23_

## Hecho

- La API ya no exige `DATABASE_URL_MIGRATIONS` al arrancar: solo la leen drizzle-kit y los tests.
- Tarea 002: backend NestJS 12 (ESM) en `apps/api` con Better Auth 1.7.12 (email + contraseña, organizaciones, admin sin suplantación), tablas `users`/`sessions`/`accounts`/`verifications`/`tenants`/`memberships`/`invitations` con RLS, tres usuarios de base (`ventas_owner`, `ventas_auth`, `ventas_app`), `TenantGuard` + transacción por request con `SET LOCAL`, seed y 27 tests e2e. Aprobada por los dos revisores (ronda 2). **Sin commitear.**
- Tarea 001: entorno de desarrollo (Postgres 18 + WAHA en Docker Compose, verificación completa).
- Tarea 000: proyecto ordenado y configuración del agente instalada. Aprobada por `revisor-codigo` y `revisor-seguridad`.

## En curso

- (nada)

## Siguiente

- Commit de la tarea 002 (lo confirma el usuario). `autenticacion-kit.zip` queda fuera del commit.
- Tarea 003: tablas de negocio (`channels`, `contacts`, `conversations`, `messages`) con FK a `tenants`/`users`, grants explícitos a `ventas_app` y RLS por `app.tenant_id`; función `SECURITY DEFINER` para resolver el tenant del webhook.
- Después: webhook de WAHA → cola (pg-boss) → guardado del mensaje.
- Tarea de endurecimiento de seguridad: ver las dos secciones de "Deuda de seguridad pendiente" en `docs/decisiones.md` (rate limit detrás de Caddy, políticas de UPDATE por rol, `REVOKE TEMPORARY`, logger sin PII, `AuthService` global, etc.).

## Bloqueos / pendientes externos

- Trámite de Tech Provider en Meta (para la API oficial): no iniciado.
- En otra máquina con un volumen de Postgres viejo hay que crear `ventas_auth` a mano (comando en `docs/entorno-dev.md`).
