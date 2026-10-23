# Tarea 002: esqueleto de NestJS + Better Auth (tablas de autenticación y empresas)

## Contexto
Primera tarea con código de aplicación. Crea el backend NestJS y configura la autenticación con Better Auth,
que genera las tablas `users`, `sessions`, `accounts`, `verifications`, `tenants`, `memberships` e
`invitations`. Spec: `docs/specs/autenticacion.md` (leerla completa antes de empezar).

La tarea 003 va a crear las tablas de negocio (`channels`, `contacts`, `conversations`, `messages`) con FK
a estas, así que los nombres y tipos de esta tarea tienen que quedar firmes.

## Objetivo
- `apps/api` con NestJS funcionando contra el Postgres local: el código de negocio conectado como `ventas_app` y Better Auth con su propio pool como `ventas_auth` (ver "Usuarios de base y RLS" en la spec).
- Better Auth con email + contraseña, plugin de organizaciones y plugin admin, con nuestros nombres de tablas y UUID.
- Migraciones con Drizzle, corridas con `ventas_owner`.
- Un guard que valide la sesión, la membresía activa y deje seteado `app.tenant_id` / `app.user_id`.

## Antes de empezar
1. Leé `CLAUDE.md`, `docs/specs/autenticacion.md` y los skills `ejecutar-tarea` y `migracion-db`.
2. Verificá que los contenedores estén corriendo (`docker compose -f infra/docker-compose.yml ps`).
3. **Consultá la documentación actual** de Better Auth (adaptador de Drizzle, plugin de organizaciones, plugin admin, `generateId`, nombres de tablas y campos, atributos de la cookie) y de la integración con NestJS. No inventes opciones: si algo de la spec no se puede configurar, avisame antes de seguir.
4. Evaluá la librería `nestjs-better-auth` (comunidad, no oficial): última versión, actividad reciente, compatibilidad con la versión de Better Auth. Proponé usarla o montar Better Auth directo en Nest, y justificá.

## Pasos / requisitos
1. **Monorepo:** `package.json` raíz con workspaces (`apps/*`, `libs/*`), TypeScript estricto, ESLint y Prettier compartidos (así el hook `formatear` empieza a funcionar).
2. **`apps/api` (NestJS):**
   - Configuración desde variables de entorno validadas al arrancar (`DATABASE_URL`, `DATABASE_URL_AUTH`, `DATABASE_URL_MIGRATIONS`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`). Better Auth usa exclusivamente el pool de `DATABASE_URL_AUTH`. Agregá las nuevas a `.env.example` sin valores reales.
   - Prefijo global `/api`.
   - Endpoint `GET /api/health` (sin autenticación) que verifique la conexión a la base.
3. **Drizzle:**
   - Generá el schema de Better Auth con su CLI (`generate`) y ajustalo a la spec: nombres de tablas y columnas en `snake_case`, UUID con default `uuidv7()`, columnas extra (`tenants.industry`, `tenants.timezone`, `tenants.status`, `memberships.status`).
   - Migraciones con Drizzle Kit, corridas con `DATABASE_URL_MIGRATIONS` (`ventas_owner`).
   - Permisos y RLS **exactamente** como la tabla "Política por tabla" de la spec: `ventas_auth` con DML sobre las tablas de autenticación y nada más; `ventas_app` sin acceso a `accounts`/`sessions`/`verifications`, con grant por columnas en `users` y RLS (`ENABLE` + `FORCE`) en `users`, `tenants`, `memberships` e `invitations`. Comentario en la migración explicando el porqué.
3b. **Nuevo usuario de base `ventas_auth`:**
   - Agregá `DB_AUTH_USER`, `DB_AUTH_PASSWORD` y `DATABASE_URL_AUTH` a `.env.example` (sin valores reales).
   - Actualizá `infra/postgres/init/01-init.sh` para que lo cree en entornos nuevos, con las mismas restricciones que `ventas_app` (sin superusuario, sin `BYPASSRLS`, `NOINHERIT`). **Esta es la única modificación permitida en `infra/`.**
   - El volumen actual ya existe, así que el script de inicio no se vuelve a ejecutar: dame el comando exacto para crear el rol en la base actual y para agregar las variables a mi `.env`. Lo ejecuto yo (vos no leés ni escribís el `.env`). Esperá a que confirme antes de seguir.
   - Actualizá `CLAUDE.md` (regla de "dos usuarios de base" → tres) y `docs/entorno-dev.md`.
4. **Better Auth:**
   - Email + contraseña. Verificación de email y recuperación de contraseña desactivadas por ahora.
   - Plugin de organizaciones con los roles `owner`, `admin`, `seller`, `viewer` definidos con `createAccessControl`.
   - Plugin admin para el administrador de la plataforma.
   - Sesión: `expiresIn` 7 días, `updateAge` 1 día, `freshAge` 1 día, **caché de cookies desactivado**.
   - Cookie `HttpOnly`, `SameSite=Lax`, `Secure` en producción.
5. **Guard de empresa:** valida la sesión → exige empresa activa → verifica membresía con `status = 'active'` → abre transacción con `SET LOCAL app.tenant_id` y `app.user_id`. Decoradores para marcar endpoints públicos y endpoints que no requieren empresa.
6. **Endpoint de prueba** `GET /api/me/context` (protegido): devuelve el usuario, la empresa activa, el rol y el valor de `current_setting('app.tenant_id')` leído desde la base. Sirve para verificar que el contexto llega a Postgres.
7. **Script de semilla para desarrollo** (`npm run db:seed`): crea dos empresas de prueba (una de cerámicos y una inmobiliaria ficticia), un `owner` en cada una y un usuario que pertenece a las dos. Sin datos reales.
8. Actualizá la sección "Comandos" de `CLAUDE.md` con los comandos nuevos.

## Criterios de aceptación
- [ ] Los de la sección "Criterios de aceptación" de `docs/specs/autenticacion.md`.
- [ ] La app se conecta como `ventas_app`; las migraciones corren como `ventas_owner`.
- [ ] Las tablas tienen los nombres de la spec, `snake_case` y UUID.
- [ ] `npm run test`, `npm run lint` y `npm run typecheck` pasan.

## Verificación (obligatoria)
1. `npm run db:migrate` corre sin errores sobre la base local; listá las tablas creadas y sus columnas.
2. `npm run db:seed` crea los datos de prueba.
3. `GET /api/health` → 200.
4. Con `curl` (guardando cookies en un archivo):
   - Registro e inicio de sesión del `owner` de cerámicos → la respuesta setea la cookie; mostrá sus atributos (`HttpOnly`, `SameSite`).
   - `GET /api/me/context` con la cookie → devuelve la empresa de cerámicos, el rol `owner` y `app.tenant_id` igual al ID de esa empresa.
   - Sin cookie → 401.
   - Logout → el siguiente request con la misma cookie → 401.
5. Usuario que pertenece a las dos empresas: cambiar la empresa activa → `/api/me/context` refleja el cambio.
6. Desactivar la membresía de un usuario (`status = 'disabled'`) → su siguiente request a un endpoint con empresa → 403.
7. En la base: ninguna contraseña en texto plano (mostrá que `accounts.password` es un hash); el rol de conexión del código de negocio es `ventas_app` y el de Better Auth es `ventas_auth` (`SELECT current_user` desde cada pool).
8. Aislamiento por usuario de base:
   - Conectado como `ventas_app`: `SELECT * FROM accounts` (y `sessions`, `verifications`) → `permission denied`.
   - Conectado como `ventas_auth`: no tiene acceso a ninguna tabla de negocio (cuando existan) ni puede crear tablas.
   - Conectado como `ventas_app` con `app.user_id` = usuario de la empresa A: solo ve la empresa A, sus membresías y sus compañeros; con el usuario que está en las dos, ve las dos. Sin `app.user_id`: 0 filas.
9. Tests automatizados que cubran los puntos 4 a 6 y 8.
10. `git status`: el `.env` no aparece.

## Fuera de alcance
- Tablas de negocio (`channels`, `contacts`, `conversations`, `messages`): son la tarea 003.
- Frontend Angular y pantallas de login.
- Login con Google, envío de emails, invitaciones por email (la tabla queda creada, el flujo no).
- Webhook de WhatsApp.

## Entregable
Resumen: estructura creada, decisión sobre `nestjs-better-auth`, tablas y columnas finales, resultado de cada
punto de la verificación, veredicto de `revisor-codigo` y `revisor-seguridad`, decisiones tomadas fuera de la
tarea (agregalas a `docs/decisiones.md`) y mensaje de commit propuesto.

## Resultado (2026-10-23)

### Archivos tocados
- **Raíz:** `package.json` (workspaces), `package-lock.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.env.example`.
- **`libs/shared`:** `src/auth/permissions.ts`, con los roles `owner`/`admin`/`seller`/`viewer` definidos con `createAccessControl`.
- **`apps/api`:**
  - `src/config` (env validado con zod; `load-env.ts`).
  - `src/db` (schema Drizzle, `APP_DB`, `pools.ts` con `assertRestrictedRole`, `tenant-context.ts`).
  - `src/auth`: `auth.ts` (configuración de Better Auth y hook de membresía), `auth-database.module.ts` (`AUTH_DB`, no global), `app-auth.module.ts`, `tenant.guard.ts`, `tenant-transaction.interceptor.ts`, `decorators.ts`.
  - `src/health`, `src/me`, `bootstrap.ts`, `main.ts`.
  - Migraciones: `drizzle/0000_auth_tables.sql` y `drizzle/0001_auth_permissions_rls.sql`.
  - `scripts/seed.ts` y los tests en `test/`.
- **Infra:** `infra/postgres/init/01-init.sh` y 2 líneas en `infra/servicios.yml` (aprobadas por el usuario).
- **Docs:** `CLAUDE.md`, `docs/entorno-dev.md`, `docs/decisiones.md` (#11 a #17 y la deuda de la tarea 002).

### Decisión sobre `nestjs-better-auth`
Se usa `@thallesp/nestjs-better-auth` 2.8.0, con versión exacta:
- Es la última versión (2026-09-03) y declara compatibilidad con `better-auth >=1.5 <2`.
- Es la integración que nombra la doc oficial de Better Auth.
- Su guard global está desactivado. El único guard global es `TenantGuard`, que llama a `getSession` directamente, porque el token de opciones del guard de la librería no se exporta.

### Verificación
1. `db:migrate`: OK. Se crearon 7 tablas con las columnas del plan. Las 7 tienen RLS `ENABLE` + `FORCE`, y los grants y las 13 políticas coinciden con la spec.
2. `db:seed`: OK. Crea 2 empresas, 3 usuarios y 4 membresías. Es idempotente, los IDs son uuidv7, y no corre en producción ni fuera de localhost.
3. `GET /api/health`: 200.
4. `curl`:
   - La cookie sale con `better-auth.session_token=…; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax` (en dev no lleva `Secure`).
   - `/api/me/context` del owner de cerámicos devuelve el rol `owner`, `currentUser: ventas_app` y `appTenantId` igual al ID de cerámicos.
   - Sin cookie: 401.
   - Después del logout, la misma cookie: 401.
5. Usuario en las dos empresas: al cambiar de cerámicos a la inmobiliaria, el rol pasa de `seller` a `viewer` y el contexto cambia.
6. Membresía desactivada: `/api/me/context` → 403 `MEMBERSHIP_INACTIVE`, y `/api/auth/organization/*` → 403 `MEMBERSHIP_DISABLED`.
7. Las contraseñas están hasheadas con scrypt (`salt:hash`). `current_user` es `ventas_app` en un pool y `ventas_auth` en el otro.
8. Aislamiento:
   - Como `ventas_app`: `permission denied` en `accounts`, `sessions` y `verifications`, y 0 filas sin contexto. La visibilidad A/B (incluido el usuario que está en las dos) es la correcta.
   - Como `ventas_auth`: no puede crear tablas, no accede a tablas de negocio ni al historial de migraciones.
9. Tests: 27/27. Cubren los puntos 4 a 8, la creación de empresas bloqueada, la suplantación (404), `TENANT_SUSPENDED` y los bypass del hook (slug, id + slug, `cancel-invitation`). Con pruebas de mutación se comprobó que los tests fallan si se saca cada protección.
10. `lint` y `typecheck` OK. `git status` no muestra el `.env`.

### Revisores
- **`revisor-codigo`: APROBADO en la ronda 2.**
  - En la ronda 1 marcó un BLOQUEANTE: el bypass del hook combinando `organizationId` y `organizationSlug`. Quedó corregido.
  - También marcó tests faltantes, el chequeo del seed y la validación de `industry`. Quedaron corregidos.
- **`revisor-seguridad`: APROBADO en la ronda 2.**
  - Sus MEDIO quedaron corregidos: el bypass de `cancel-invitation`, el pool de `ventas_auth` que quedaba al alcance de todo el código, y la cookie y el seed que dependían de `NODE_ENV`.
  - El MEDIO de `DATABASE_URL_MIGRATIONS` no se aplicó porque la tarea lo pide; queda para que lo decida el usuario.
  - Los BAJO quedaron como deuda en `docs/decisiones.md`.

### Decisiones fuera de la tarea
Están en `docs/decisiones.md` (#11 a #17):
- Política de RLS `TO ventas_auth USING (true)`.
- Funciones `SECURITY DEFINER` para las políticas de `tenants` y `users`.
- Guard más interceptor con `AsyncLocalStorage`.
- Emails en `text` con `CHECK` en minúsculas, en lugar de `citext`.
- Hook global de Better Auth para las membresías desactivadas.
- TypeScript 6.0.3.
- Carga del `.env` local desde `load-env.ts`.
