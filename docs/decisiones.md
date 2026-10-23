# Decisiones del proyecto

Registro de decisiones de arquitectura y producto. La más nueva arriba. Cada una: qué se decidió, por qué y qué se descartó.

| # | Fecha | Decisión | Por qué | Descartado |
|---|---|---|---|---|
| 17 | 2026-10-23 | Funciones `SECURITY DEFINER` (`app_user_tenant_ids`, `app_visible_user_ids`) para las políticas de `tenants` y `users`, con `search_path` fijo y `EXECUTE` solo para `ventas_app` | Las políticas tienen que mirar `memberships` sin que su propia RLS esconda a los compañeros de otras empresas. Hoy funcionan porque `ventas_owner` es superusuario en el contenedor; **en producción, si el dueño no es superusuario, necesita `BYPASSRLS`** | Subconsultas directas (la RLS de `memberships` las recorta) |
| 16 | 2026-10-23 | Membresía `disabled` bloqueada también en `/api/auth/organization/*` con un hook global `hooks.before` de Better Auth; creación de empresas solo desde el servidor (`allowUserToCreateOrganization: false`); suplantación desactivada (`disabledPaths` + rol admin sin `impersonate`) | Esas rutas no pasan por los guards de Nest, y el plugin no conoce nuestro `status`. `organizationHooks` no cubre `set-active` ni `update` | Solo `organizationHooks`; bloquear todas las rutas de organización |
| 15 | 2026-10-23 | `TenantGuard` (valida sesión → empresa activa → membresía activa) + `TenantTransactionInterceptor` (abre LA transacción del request con `SET LOCAL` y la expone con `AsyncLocalStorage`). Un solo guard global; el de la librería queda desactivado | Un guard de Nest no puede envolver la ejecución del handler. El `AuthGuard` de la librería no se puede componer (su token de opciones no se exporta) y dos guards globales dependen del orden de registro | Transacción abierta en el guard; usar el guard global de la librería |
| 14 | 2026-10-23 | Emails en `text` + `UNIQUE` + `CHECK (email = lower(email))`, no `citext` | El chequeo de schema de Better Auth al arrancar exige columnas de tipo string en Drizzle; Better Auth ya normaliza a minúsculas | `citext` con `customType` |
| 13 | 2026-10-23 | Tres usuarios de base: `ventas_owner` (migraciones), `ventas_auth` (solo Better Auth, pool propio), `ventas_app` (negocio). RLS `ENABLE + FORCE` en las 7 tablas de autenticación, con política `TO ventas_auth USING (true)` y políticas propias para `ventas_app` | Better Auth lee sus tablas antes de conocer la empresa; separarlo evita que un bug del negocio lea contraseñas o sesiones. Con RLS forzada, sin esa política `ventas_auth` vería 0 filas | Un solo usuario de app; dar `BYPASSRLS` a `ventas_auth` |
| 12 | 2026-10-23 | Better Auth 1.7.12 montado con `@thallesp/nestjs-better-auth` 2.8.0 (versión exacta), Drizzle 0.45 + `pg`, Nest 12 y todo el backend en ESM, TypeScript 6.0.3 | Es la integración que nombra la doc de Better Auth y resuelve el body parser y el handler de Express 5. TS 6 porque `typescript-eslint` pide `<6.1` | Montar Better Auth a mano; TypeScript 7 |
| 11 | 2026-10-23 | Tablas y columnas propias (`users`, `tenants`, `memberships`…, `snake_case`, `tenant_id`, `active_tenant_id`) mapeadas desde Better Auth; IDs `uuidv7()` puestos por la base (`generateId: 'uuid'`) | La spec y la tarea 003 dependen de estos nombres. La API JSON de Better Auth sigue diciendo `organizationId`: solo cambia la base | Usar los nombres por defecto de Better Auth |
| 10 | 2026-10-23 | Los hooks y `permissions.deny` son red de seguridad, no la barrera única; el hook normaliza comillas, barras y `+` y bloquea `.env`, `docker compose config`, git destructivo, `rm -r` y SQL destructivo | El revisor de seguridad mostró evasiones simples del hook original; cualquier borrado recursivo lo ejecuta el usuario | Confiar solo en el hook |
| 9 | 2026-10-22 | IA vía OpenRouter, sin modelo propio | Pago por uso; un modelo en el VPS sería lento y de baja calidad, y uno con GPU cuesta cientos de USD/mes | Modelo local en VPS (CPU o GPU) |
| 8 | 2026-10-22 | WAHA como proveedor no oficial | Ya funcionando, un solo contenedor, varios motores, sin condiciones extra de licencia | Evolution API (más dependencias y condiciones de marca en la licencia) |
| 7 | 2026-10-20 | Doble proveedor de WhatsApp detrás de `WhatsAppProvider` (WAHA no oficial + Cloud API oficial con coexistencia) | Ofrecer las dos opciones al cliente sin duplicar la lógica | Elegir uno solo |
| 6 | 2026-10-20 | Todo lo específico de un negocio va en configuración (`tenant_configs`, base de conocimiento, catálogo importado) | Producto escalable a cualquier rubro de ventas | Lógica hardcodeada para un cliente |
| 5 | 2026-10-20 | La IA filtra leads (caliente / tibio / consulta simple / no es venta) y no responde a calientes ni cuando responde un humano | Ahorrar tiempo al vendedor sin pisarle las ventas | IA respondiendo todo |
| 4 | 2026-10-20 | Postgres 18 con RLS y dos usuarios (`ventas_owner` migraciones, `ventas_app` aplicación) | La RLS no se aplica al dueño de las tablas | Un solo usuario |
| 3 | 2026-10-20 | Entorno local con Docker Compose (Postgres + WAHA); backend y front en el host | Recarga rápida y entorno reproducible | Instalar Postgres en el sistema |
| 2 | 2026-10-20 | NestJS + Angular en monorepo, TypeScript en todo el stack | Mismo modelo mental en front y back, tipos compartidos | Spring Boot, Next.js full-stack |
| 1 | 2026-10-20 | Trabajo con un ejecutor y dos subagentes revisores (código y seguridad) | Que el trabajo no se califique a sí mismo | Revisión manual únicamente |

## Deuda de seguridad pendiente (hallazgos menores de la tarea 000)

Detectados por `revisor-seguridad`; no bloquean, quedan para una tarea de endurecimiento:

- Matcher de `PreToolUse` en `.claude/settings.json` es solo `Bash`: si hay herramienta PowerShell, el hook no corre ahí. Pasar a `Bash|PowerShell`.
- Lectura indirecta de secretos que hoy pasa: `grep -r PASSWORD infra` y `docker compose ... exec postgres env`.
- Faltan en `permissions.deny`: `Edit/Write(**/.env.development)`, `.env.test`, `.env.staging`.
- Evasiones deliberadas poco realistas: `.[e]nv`, `.{e,}nv`, `rm -f -r`, `git push -uf`, `DELETE FROM x` sin `;` y con argumentos después.
- Falsos positivos conocidos: `git rm -r --cached`, `grep ".*"` y `docker compose logs ... | grep config` quedan bloqueados.

## Deuda de seguridad pendiente (tarea 002, autenticación)

Hallazgos de `revisor-seguridad` y `revisor-codigo` que no bloquean; quedan para la tarea de endurecimiento o de despliegue:

- ~~`DATABASE_URL_MIGRATIONS` obligatoria en el env de la API~~ — resuelto (2026-10-23): la API ya no la valida; solo la leen `drizzle.config.ts` y los tests e2e (limpieza como `ventas_owner`). Con `NODE_ENV=production`, `parseEnv` no deja arrancar la API si la variable llega definida.
- `NODE_ENV` tiene default `development`. La cookie `Secure` ya se activa también con `BETTER_AUTH_URL` https y el seed solo corre contra localhost, pero el rate limit de Better Auth sigue dependiendo de `NODE_ENV=production`.
- Rate limit detrás de Caddy: configurar `advanced.ipAddress.ipAddressHeaders` y que la API escuche solo en `127.0.0.1`.
- Políticas de UPDATE de `tenants` y `memberships` no miran el rol (owner/admin) ni impiden asignar `owner`: hoy lo validan los servicios (no hay endpoints que actualicen).
- Funciones `SECURITY DEFINER` propiedad del superusuario: en producción, pasarlas a un rol sin login con `BYPASSRLS` y solo `SELECT` sobre `memberships`.
- `ventas_app` y `ventas_auth` tienen `TEMPORARY` sobre la base (default de `PUBLIC`): `REVOKE TEMPORARY ON DATABASE ventas FROM PUBLIC`.
- Logger de Better Auth sin filtro: hoy en nivel `warn` no sale PII, pero conviene un `logger.log` propio que no imprima emails.
- Una empresa `suspended` sigue administrable por `/api/auth/organization/*` (el hook solo mira la membresía).
- `/sign-up/email` revela si un email ya existe (revisar al activar la verificación de email).
- Tests faltantes: `@NoTenant` (no hay endpoint que lo use todavía) y rollback del interceptor ante error.
- `AuthService` de la librería es global (`isGlobal: true`): cualquier servicio de negocio podría usar `auth.api.*` sin headers o el adapter de Better Auth y llegar a `sessions`/`accounts` como `ventas_auth`. Agregar `no-restricted-imports` de `@thallesp/nestjs-better-auth` y `better-auth` fuera de `apps/api/src/auth/`.
