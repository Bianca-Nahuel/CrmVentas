# Tarea 003: tablas de mensajería (channels, contacts, conversations, messages) con RLS

## Contexto

La tarea 002 dejó el backend NestJS con Better Auth, las tablas `users`, `sessions`, `accounts`,
`verifications`, `tenants`, `memberships` e `invitations`, los tres usuarios de base y el contexto
`app.user_id` / `app.tenant_id` por request. Esta tarea crea las 4 tablas de negocio donde va a caer
cada mensaje de WhatsApp, con el aislamiento entre empresas que exige `CLAUDE.md`.

La tarea 004 (webhook de WAHA → cola → guardado) va a escribir en estas tablas, así que los nombres,
tipos y restricciones quedan firmes acá.

Referencias: `docs/specs/autenticacion.md` (sección "Usuarios de base y RLS"), skill `migracion-db`,
skill `webhook-whatsapp`, y la migración de permisos de la tarea 002 (`drizzle/0001_*.sql`), que define
los helpers `app_tenant_id()` / `app_user_id()` y el trigger `set_updated_at()`.

## Objetivo

- Schema de Drizzle y migración de las 4 tablas, con RLS (`ENABLE` + `FORCE`), grants mínimos y los
  índices necesarios.
- Una función `SECURITY DEFINER` para que el futuro webhook pueda saber de qué empresa es un número
  **antes** de tener `app.tenant_id`.
- Tests que prueben el aislamiento entre empresas y la idempotencia.

## Antes de empezar

1. Leé `CLAUDE.md`, los skills `ejecutar-tarea`, `migracion-db` y `webhook-whatsapp`, y la migración de
   permisos de la tarea 002 para reutilizar sus helpers y su estilo.
2. Verificá que las migraciones actuales estén aplicadas y que los tests de la 002 pasen.

## Tablas

Convenciones de todas: `id uuid PK DEFAULT uuidv7()`, `tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE`,
`timestamptz`, `created_at`/`updated_at` con el trigger `set_updated_at()` (salvo `messages`, ver abajo),
estados como `text` + `CHECK`.

### `channels`: números de WhatsApp conectados

| Columna            | Tipo        | Restricciones                                                                        |
| ------------------ | ----------- | ------------------------------------------------------------------------------------ |
| `name`             | text        | NOT NULL (ej. "ventas-principal")                                                    |
| `phone_number`     | text        | NOT NULL, formato E.164 (`CHECK` con regex `^\+[1-9][0-9]{6,14}$`)                   |
| `provider`         | text        | NOT NULL, CHECK (`waha`, `cloud_api`)                                                |
| `connection_type`  | text        | NOT NULL, CHECK (`official`, `unofficial`)                                           |
| `external_id`      | text        | ID en el proveedor (sesión de WAHA o `phone_number_id` de Meta)                      |
| `status`           | text        | NOT NULL default `pending`, CHECK (`pending`, `connected`, `disconnected`, `banned`) |
| `default_user_id`  | uuid        | NULL, FK `users` ON DELETE SET NULL                                                  |
| `risk_accepted_at` | timestamptz | NULL                                                                                 |
| `risk_accepted_by` | uuid        | NULL, FK `users` ON DELETE SET NULL                                                  |
| `provider_config`  | jsonb       | NOT NULL default `'{}'` — **sin secretos**                                           |

- UNIQUE `(tenant_id, phone_number)`; UNIQUE `(provider, external_id)`.
- CHECK: si `connection_type = 'unofficial'` entonces `risk_accepted_at` y `risk_accepted_by` no son nulos.
- CHECK de coherencia: `provider = 'waha'` ⇒ `connection_type = 'unofficial'`; `provider = 'cloud_api'` ⇒ `official`.
- Los tokens o API keys de cada canal **no** van en esta tabla (se resuelve cuando exista la Cloud API).

### `contacts`: clientes finales

| Columna                         | Tipo        | Restricciones                                  |
| ------------------------------- | ----------- | ---------------------------------------------- |
| `wa_id`                         | text        | NOT NULL (número en E.164)                     |
| `profile_name`                  | text        | nombre del perfil de WhatsApp                  |
| `display_name`                  | text        | corregido por un vendedor o extraído por la IA |
| `marketing_opt_in`              | boolean     | NOT NULL default false                         |
| `opt_in_at`                     | timestamptz | NULL                                           |
| `blocked`                       | boolean     | NOT NULL default false                         |
| `first_seen_at`, `last_seen_at` | timestamptz | NOT NULL                                       |

- UNIQUE `(tenant_id, wa_id)`. CHECK: `marketing_opt_in` ⇒ `opt_in_at IS NOT NULL`.

### `conversations`: hilos

| Columna            | Tipo        | Restricciones                                                 |
| ------------------ | ----------- | ------------------------------------------------------------- |
| `channel_id`       | uuid        | NOT NULL, FK `channels` ON DELETE CASCADE                     |
| `contact_id`       | uuid        | NOT NULL, FK `contacts` ON DELETE CASCADE                     |
| `status`           | text        | NOT NULL default `open`, CHECK (`open`, `closed`, `archived`) |
| `inbox`            | text        | NOT NULL default `sales`, CHECK (`sales`, `other`)            |
| `assigned_user_id` | uuid        | NULL, FK `users` ON DELETE SET NULL                           |
| `ai_paused_until`  | timestamptz | NULL                                                          |
| `last_message_at`  | timestamptz | NOT NULL                                                      |
| `last_inbound_at`  | timestamptz | NULL                                                          |

- UNIQUE parcial `(channel_id, contact_id) WHERE status = 'open'`.
- Índices: `(tenant_id, last_message_at DESC)` y `(tenant_id, assigned_user_id)`.
- **Consistencia entre empresas:** `channel_id` y `contact_id` tienen que pertenecer al mismo `tenant_id`
  que la conversación. Resolvelo con FKs compuestas (`(tenant_id, id)` UNIQUE en `channels` y `contacts`,
  y FK `(tenant_id, channel_id)` / `(tenant_id, contact_id)`), no solo con código.

### `messages`: mensajes

| Columna           | Tipo          | Restricciones                                                                        |
| ----------------- | ------------- | ------------------------------------------------------------------------------------ |
| `conversation_id` | uuid          | NOT NULL, FK compuesta `(tenant_id, conversation_id)`                                |
| `channel_id`      | uuid          | NOT NULL, FK compuesta `(tenant_id, channel_id)`                                     |
| `external_id`     | text          | NOT NULL                                                                             |
| `direction`       | text          | NOT NULL, CHECK (`inbound`, `outbound`)                                              |
| `sender_type`     | text          | NOT NULL, CHECK (`contact`, `ai`, `user`, `app`)                                     |
| `sent_by_user_id` | uuid          | NULL, FK `users` ON DELETE SET NULL                                                  |
| `type`            | text          | NOT NULL, CHECK (`text`, `image`, `audio`, `video`, `document`, `location`, `other`) |
| `body`            | text          | NULL                                                                                 |
| `media_key`       | text          | NULL (key en R2)                                                                     |
| `status`          | text          | CHECK (`received`, `sent`, `delivered`, `read`, `failed`)                            |
| `cost_usd`        | numeric(10,5) | NULL                                                                                 |
| `raw`             | jsonb         | NOT NULL                                                                             |
| `sent_at`         | timestamptz   | NOT NULL                                                                             |
| `created_at`      | timestamptz   | NOT NULL default now()                                                               |

- **Idempotencia:** UNIQUE `(channel_id, external_id)`.
- Índice `(conversation_id, sent_at)`.
- Sin `updated_at` ni trigger: los mensajes no se editan salvo `status` (y eventualmente `cost_usd`).
- CHECK de coherencia: `direction = 'inbound'` ⇔ `sender_type = 'contact'`.

## Permisos y RLS

- Las 4 tablas: `ENABLE` + `FORCE ROW LEVEL SECURITY`, política `tenant_id = app_tenant_id()` para
  `ventas_app` (USING y WITH CHECK).
- `ventas_auth`: **ningún** permiso ni política en estas tablas.
- Revisá los default privileges de la tarea 001: hacé `REVOKE ALL` y después otorgá exactamente:
  - `channels`, `contacts`, `conversations`: `SELECT, INSERT, UPDATE` (sin `DELETE`: se archivan o desactivan).
  - `messages`: `SELECT, INSERT`, y `UPDATE` **solo de las columnas** `status` y `cost_usd`.
- Comentario en la migración explicando cada decisión.
- La restricción de que un `seller` vea solo lo suyo **no** va en la RLS de esta tarea: va en los servicios (tarea futura).

## Función para el webhook

`resolve_channel(p_provider text, p_external_id text) RETURNS TABLE (channel_id uuid, tenant_id uuid)`:

- `SECURITY DEFINER`, `STABLE`, `SET search_path = pg_catalog, public`.
- Devuelve **solo** esos dos campos del canal con ese proveedor e `external_id`, y solo si su `status`
  no es `banned` y la empresa está `active`.
- `REVOKE ALL ... FROM PUBLIC`; `EXECUTE` solo para `ventas_app`.
- Mismo criterio que los helpers de la 002 respecto del dueño superusuario (ya anotado en `decisiones.md`).

## Schema de Drizzle

- `apps/api/src/db/schema/messaging.ts`, exportado junto con el de auth.
- Tipos inferidos exportados para usarlos en la tarea 004.

## Criterios de aceptación

- [ ] Las 4 tablas existen con las columnas, tipos, CHECKs, UNIQUEs, FKs compuestas e índices descritos.
- [ ] RLS forzada y grants exactos según la sección de permisos.
- [ ] `resolve_channel` funciona sin `app.tenant_id` y no expone ningún otro dato.
- [ ] Tests automatizados de los puntos 4 a 9 de la verificación.
- [ ] `npm run test`, `npm run lint` y `npm run typecheck` pasan.

## Verificación (obligatoria)

1. `npm run db:migrate` sin errores; mostrá `\d+` de las 4 tablas.
2. El seed (o los tests) crea, para las dos empresas demo, un canal, un contacto, una conversación y dos mensajes en cada una.
3. Como `ventas_app` **sin** `app.tenant_id`: las 4 tablas devuelven 0 filas.
4. Como `ventas_app` con `app.tenant_id` = empresa A: ve solo los datos de A; un `UPDATE` sobre una fila de B afecta 0 filas; un `INSERT` con `tenant_id` de B falla.
5. Una conversación con `channel_id` de A y `contact_id` de B (aun con el mismo `tenant_id` declarado) falla por las FKs compuestas.
6. Insertar dos veces el mismo `(channel_id, external_id)` en `messages`: el segundo con `ON CONFLICT DO NOTHING` no inserta nada.
7. Como `ventas_app`: `DELETE` en cualquiera de las 4 tablas → `permission denied`; `UPDATE messages SET body = ...` → `permission denied`; `UPDATE messages SET status = 'read'` → funciona.
8. Como `ventas_auth`: `SELECT` en cualquiera de las 4 tablas → `permission denied`.
9. `resolve_channel('waha', '<external_id de A>')` como `ventas_app` sin contexto → devuelve el canal y el tenant de A; con un `external_id` inexistente o un canal `banned` → 0 filas.
10. Crear un canal `unofficial` sin `risk_accepted_at` → falla por el CHECK.
11. `git status`: sin `.env`.

## Fuera de alcance

- El webhook de WAHA, la cola y el procesamiento de mensajes (tarea 004).
- Endpoints REST para administrar canales o ver conversaciones.
- Tablas de leads, configuración del negocio, catálogo.
- Guardar secretos de los canales.

## Entregable

Resumen: archivos creados, resultado de cada punto de la verificación, veredicto de `revisor-codigo` y
`revisor-seguridad`, decisiones fuera de la tarea (a `docs/decisiones.md`) y mensaje de commit propuesto.

## Resultado

_Cerrada el 2026-10-23._

### Archivos

- Nuevos: `apps/api/src/db/schema/messaging.ts`, `apps/api/drizzle/0002_messaging_tables.sql` (generada),
  `apps/api/drizzle/0003_messaging_permissions_rls.sql` (a mano), `apps/api/drizzle/meta/0002_snapshot.json`,
  `apps/api/drizzle/meta/0003_snapshot.json`, `apps/api/test/messaging-isolation.test.ts`.
- Modificados: `apps/api/drizzle/meta/_journal.json`, `apps/api/src/db/pools.ts` (el pool de `ventas_app` incluye el
  schema de mensajería), `apps/api/scripts/seed.ts` (datos de mensajería por empresa demo, vía `ventas_app`),
  `apps/api/test/helpers.ts` (`withTenant`, `errorCodeIn`), `docs/decisiones.md`.

### Verificación

1. `npm run db:migrate` aplicó 0002 y 0003 sin errores; `\d+` de las 4 tablas muestra columnas, CHECKs, UNIQUEs, FKs
   compuestas, índices, trigger y `Policies (forced row security enabled)`.
2. El seed (idempotente, corrido dos veces) y los tests crean 1 canal, 1 contacto, 1 conversación y 2 mensajes por empresa.
3. a 10. Cubiertos por `messaging-isolation.test.ts` (33 tests, todos pasan), más grants exactos contra
   `information_schema`, RLS forzada, UNIQUE parcial de conversaciones abiertas, FKs de usuarios por membresía y trigger
   de `updated_at`.
4. `git status`: sin `.env`.

`npm run test` 63/63 · `npm run lint` OK · `npm run typecheck` OK.

### Revisores

- `revisor-codigo`: **APROBADO**, sin bloqueantes. Corregido: faltaban en `decisiones.md` las decisiones de la tarea
  (agregadas, #18 a #21) y tres tests (FK de `sent_by_user_id` a otra empresa, CHECK de `provider_config`, UNIQUE global de
  `external_id`: agregados). Índices de FKs a `memberships`: anotado como deuda.
- `revisor-seguridad`: **APROBADO**, sin CRÍTICO/ALTO. MEDIO (secuestro de número vía `external_id`) y BAJO
  (`risk_accepted_by` de otra empresa, campos de sistema editables) quedan como criterios para la 004 y los endpoints de
  canales en `decisiones.md`; nota de producción de `SECURITY DEFINER` completada. El BAJO "falta test del punto 8" ya estaba
  cubierto (`SELECT` real como `ventas_auth` por tabla).

### Decisiones (aprobadas por el usuario antes de implementar)

- A1: `risk_accepted_by` → `users` `ON DELETE RESTRICT` (la spec decía `SET NULL`, que choca con el CHECK).
- B1: `default_user_id`, `assigned_user_id`, `sent_by_user_id` → `memberships (tenant_id, user_id)` `ON DELETE SET NULL (col)`.
- C1: `messages` → `conversations (tenant_id, id, channel_id)`.
- Extras: CHECK `jsonb_typeof(provider_config) = 'object'`; índices `(tenant_id, channel_id)` y `(tenant_id, contact_id)` en
  `conversations`; `UPDATE` por columnas (también sin `updated_at`, que lo pone el trigger); sin CHECK E.164 en
  `contacts.wa_id` (LIDs de WhatsApp).
