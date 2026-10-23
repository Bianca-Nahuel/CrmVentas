# Estado del proyecto

_Última actualización: 2026-10-23_

## Hecho
- Tarea 001: entorno de desarrollo (Postgres 18 + WAHA en Docker Compose, dos usuarios de base, verificación completa).
- Tarea 000: proyecto ordenado y configuración del agente instalada (`CLAUDE.md`, `.claude/` con reglas, skills, subagentes revisores y hooks, `docs/`, `evals/`). Aprobada por `revisor-codigo` y `revisor-seguridad`; hook `guardia-bash` y `permissions.deny` endurecidos.

## En curso
- (nada)

## Siguiente
- Borrar `kit-agente/` (lo ejecuta el usuario: el hook bloquea `rm -r`). Después, commit de la tarea 000.
- Tarea 002: migración inicial con las 7 tablas (`tenants`, `users`, `memberships`, `channels`, `contacts`, `conversations`, `messages`) con RLS.
- Después: proyecto NestJS + webhook de WAHA → cola → guardado del mensaje.
- Tarea de endurecimiento de seguridad (ver "Deuda de seguridad pendiente" en `docs/decisiones.md`).

## Bloqueos / pendientes externos
- Trámite de Tech Provider en Meta (para la API oficial): no iniciado.
