# Tarea 004: webhook de WAHA → cola → guardado idempotente

## Contexto

La tarea 003 dejó las tablas `channels`, `contacts`, `conversations` y `messages` con RLS, y la función
`resolve_channel(provider, external_id)`. Esta tarea hace que un mensaje real que llega al número de prueba
termine guardado en `messages`, en la empresa correcta, una sola vez.

Es la primera entrada de datos externos al sistema, así que la seguridad importa tanto como que funcione.

Referencias: `CLAUDE.md` (webhooks: 200 + cola + idempotencia + raw), skill `webhook-whatsapp`,
`.claude/rules/whatsapp.md`, y en `docs/decisiones.md` la regla que dejó el revisor de seguridad en la 003:
el `external_id` de un canal **nunca** viene del cliente.

## Objetivo

- Endpoint `POST /api/webhooks/waha` que verifica la firma de WAHA, encola el evento y responde 200 enseguida.
- Worker con pg-boss que normaliza el evento y lo guarda: contacto, conversación y mensaje, dentro de la
  RLS de la empresa dueña del canal.
- Script de desarrollo para crear el canal del número de prueba con su sesión de WAHA, con el
  `external_id` generado por el backend.

## Antes de empezar

1. Leé `CLAUDE.md`, los skills `ejecutar-tarea` y `webhook-whatsapp`, `.claude/rules/whatsapp.md` y las
   decisiones #18 a #21.
2. **Consultá la documentación actual de WAHA** (versión instalada en `infra/servicios.yml`, engine NOWEB):
   - webhooks por sesión al crear la sesión (`config.webhooks`), eventos disponibles y formato del payload;
   - **firma HMAC** del webhook (encabezados, algoritmo, sobre qué bytes se calcula);
   - cómo vienen los identificadores del remitente (`@c.us`, `@lid`, grupos, estados, canales);
   - API para crear, iniciar y consultar sesiones.
     No inventes nombres de campos: si algo no coincide con esta tarea, avisame antes de seguir.
3. **Consultá la documentación actual de pg-boss** (versión, creación del schema, roles necesarios, retención).
4. Revisá en `infra/servicios.yml` los puertos de WAHA y de la API, y cómo llega WAHA (en Docker) a la API
   (en el host). En Windows con Docker Desktop debería ser `host.docker.internal`. **No modifiques `infra/`**:
   si hace falta un cambio, proponémelo.

## Pasos / requisitos

### 1. Variables de entorno

Agregá a `.env.example`, sin valores reales, y validalas al arrancar:

- `WAHA_BASE_URL`: URL de la API de WAHA vista desde el backend.
- `WAHA_API_KEY`: si ya existe para el contenedor, reutilizala; no dupliques.
- `WAHA_WEBHOOK_URL`: URL del webhook vista **desde el contenedor de WAHA**.
- `WAHA_WEBHOOK_HMAC_KEY`: mínimo 32 bytes; la validación rechaza claves cortas.

Dame los comandos exactos para generar la clave y la lista de líneas para agregar a mi `.env`. Lo hago yo
(vos no leés ni escribís el `.env`). Esperá mi confirmación.

### 2. Endpoint del webhook

- `POST /api/webhooks/waha`, con `@Public()` y `@NoTenant()`. **No** abre la transacción de empresa ni toca
  tablas de negocio.
- Verifica la **firma HMAC sobre el cuerpo crudo** (habilitá `rawBody` en Nest solo donde haga falta).
  Compará con `timingSafeEqual`. Si la firma falta o es inválida → 401, sin detalles en la respuesta.
- Límite de tamaño del cuerpo (por ejemplo 1 MB) y validación mínima de forma con zod (`event`, `session`,
  `payload`). Un evento con forma inválida → 400.
- Eventos que no procesamos → 200 sin encolar.
- Encola el evento validado en pg-boss y responde **200 sin esperar** el procesamiento.

### 3. Cola (pg-boss)

- El schema de pg-boss lo crea `ventas_owner` en tiempo de migración, no la app al arrancar.
- `ventas_app` solo tiene los permisos que pg-boss necesita sobre su schema; `ventas_auth`, ninguno.
  Documentá los grants y el porqué en la migración.
- Los trabajos llevan datos personales (teléfono, texto). Configurá una retención corta de trabajos
  completados (por ejemplo 1 día) y anotalo en `decisiones.md`.
- Reintentos con backoff para errores transitorios. Un canal inexistente o `banned` **no** se reintenta:
  se descarta con un log.
- El worker corre en el mismo proceso que la API (MVP); dejalo en un módulo separado para poder moverlo después.

### 4. Normalización (proveedor → evento interno)

- Todo lo específico de WAHA queda en `apps/api/src/providers/waha/`. Afuera solo existen los eventos
  normalizados (`message.received`, `session.status`) definidos en `libs/shared`.
- Funciones puras y testeables. Fixtures de payloads de WAHA **inventados y anonimizados**, en
  `apps/api/test/fixtures/waha/`.
- Se procesan en esta tarea:
  - `message` entrante de un contacto individual → `message.received`.
  - `session.status` → actualiza `channels.status` (mapeo documentado).
- Se ignoran, con 200: mensajes propios (`fromMe`), grupos, estados (`status@broadcast`), canales/newsletters,
  y cualquier otro evento.
- Tipos: texto, imagen, audio, video, documento, ubicación; lo demás → `other`. Para multimedia, `body` es el
  epígrafe si lo hay. **No** se descarga el archivo (eso va con R2, más adelante); los datos quedan en `raw`.
- `sent_at` sale del timestamp del mensaje, no de `now()`.
- **Identificador del contacto:** normalizá a E.164 desde `@c.us`. Si WAHA entrega un identificador `@lid`
  sin el número, investigá en la documentación cómo obtener el número. Si hace falta cambiar el schema de
  `contacts`, proponémelo antes y no lo hagas por tu cuenta.

### 5. Guardado (worker)

1. `resolve_channel('waha', session)` → si no hay resultado, descartar con log.
2. Abrir **una** transacción con `SET LOCAL app.tenant_id` (reutilizá el helper de la 002; no dupliques la
   lógica del interceptor) y hacer todo adentro:
   - upsert de `contacts` por `(tenant_id, wa_id)`: `profile_name`, `last_seen_at`;
   - buscar la conversación abierta del canal y el contacto, o crearla;
   - `INSERT` en `messages` con `ON CONFLICT (channel_id, external_id) DO NOTHING`;
   - **solo si se insertó**, actualizar `last_message_at` y `last_inbound_at` de la conversación.
3. Dos trabajos simultáneos del mismo contacto no deben crear dos conversaciones abiertas: manejá la
   carrera contra el UNIQUE parcial (reintento de la búsqueda, o `ON CONFLICT`).

### 6. Script de canal de desarrollo

`npm run dev:create-channel -- --tenant <slug> --name <nombre> --phone <+54...>`:

- Crea el canal `waha` / `unofficial` en la empresa indicada, con `risk_accepted_at` y `risk_accepted_by` = el
  `owner` del seed.
- **Genera el `external_id` en el backend** (por ejemplo `ch_` + id del canal sin guiones). No se acepta por
  parámetro. Respetá los caracteres que admite WAHA para nombres de sesión.
- Crea e inicia la sesión en WAHA con ese nombre y el webhook configurado (URL, eventos, HMAC).
- Imprime el nombre de la sesión para que yo escanee el QR desde el dashboard. Solo funciona con
  `NODE_ENV` distinto de `production`.

### 7. Logs

Sin datos personales: nada de texto, teléfono ni nombre. Sí: id del evento, id del canal, tipo y resultado
(guardado, duplicado, ignorado, descartado).

## Criterios de aceptación

- [ ] El webhook rechaza firmas inválidas o ausentes y responde 200 sin esperar el procesamiento.
- [ ] Un mensaje entrante queda guardado una sola vez, en la empresa del canal, con contacto y conversación correctos.
- [ ] Ningún evento de un canal de la empresa A puede terminar en la empresa B.
- [ ] Nada específico de WAHA fuera de `providers/waha/`.
- [ ] `npm run test`, `npm run lint` y `npm run typecheck` pasan.

## Verificación (obligatoria)

1. Firma: válida → 200; ausente → 401; inválida → 401; cuerpo modificado después de firmar → 401.
2. Forma inválida → 400; evento no procesado (por ejemplo `presence.update`) → 200 sin trabajo en la cola.
3. Normalización (tests unitarios con fixtures): texto, imagen con epígrafe, audio, ubicación → tipo y `body`
   correctos; `fromMe`, grupo, estado y newsletter → ignorados; número `@c.us` → E.164.
4. Integración: evento firmado → trabajo procesado → 1 fila en `messages` con el `tenant_id` del canal,
   contacto y conversación creados, `sent_at` del payload.
5. Idempotencia: el mismo evento dos veces → sigue habiendo 1 mensaje, y `last_message_at` no cambia en el segundo.
6. Segundo mensaje del mismo contacto → misma conversación, mismo contacto.
7. Carrera: dos eventos distintos del mismo contacto nuevo procesados en paralelo → 1 contacto y 1 conversación abierta.
8. Aislamiento: canales de las dos empresas demo, eventos para cada una → cada mensaje solo es visible en su empresa.
9. Sesión desconocida → 200, nada guardado, log "descartado", sin reintentos.
10. `session.status` → cambia `channels.status`.
11. Permisos: `ventas_auth` sin acceso al schema de pg-boss; `ventas_app` sin `CREATE` en ningún schema.
12. Logs de los tests 4 y 5: sin texto ni teléfonos.
13. **Prueba real (la hago yo con vos):**
    - creás el canal con el script en la empresa de cerámicos;
    - escaneo el QR con el **número de prueba**;
    - desde otro teléfono le mando un texto y una foto con epígrafe;
    - mostrás las filas en `messages` y `conversations`.
14. `git status`: sin `.env`.

## Fuera de alcance

- Enviar mensajes, ecos de mensajes propios (`message.any`, `fromMe`) y pausa de la IA: tarea 005.
- IA y clasificación: tarea 006.
- Descarga de multimedia a R2.
- Endpoints o pantallas para administrar canales y la conexión por QR desde el panel: tarea 008.
- Cloud API de Meta.

## Entregable

Resumen: archivos creados, decisiones sobre pg-boss (schema, roles, retención) y sobre los identificadores
`@lid`, resultado de cada punto de la verificación, veredicto de `revisor-codigo` y `revisor-seguridad`,
decisiones nuevas en `docs/decisiones.md` y mensaje de commit propuesto.

## Resultado (2026-10-24)

### Archivos

- **Migraciones:** `apps/api/drizzle/0004_pgboss.sql` (schema `pgboss` de pg-boss 12.37.1 creado por `ventas_owner`, cola `whatsapp-inbound`, grants) y `0005_pgboss_retries.sql` (10 reintentos, techo de 5 min).
- **Cola:** `apps/api/src/jobs/jobs.module.ts` (pg-boss como `ventas_app`, sin crear schema ni migrar).
- **Webhook:** `apps/api/src/http/webhook-body.ts` (cuerpo crudo solo en `/api/webhooks/*`, U+0000), `apps/api/src/whatsapp/providers/waha/` (`waha-signature.ts`, `waha-normalize.ts`, `waha-client.ts`, `waha.provider.ts`, `waha-webhook.controller.ts`), `apps/api/src/whatsapp/{provider.ts, whatsapp.module.ts}`.
- **Worker:** `apps/api/src/whatsapp/inbound/` (`inbound.service.ts`, `inbound.worker.ts`, `inbound-job.ts`, `inbound.module.ts`); `withTenantTransaction` en `apps/api/src/db/tenant-context.ts`.
- **Eventos normalizados:** `libs/shared/src/whatsapp/events.ts`.
- **Scripts de desarrollo:** `apps/api/scripts/create-dev-channel.ts`, `sync-channel-webhook.ts`, `lib/waha-session.ts`.
- **Configuración:** `apps/api/src/config/env.ts` (`WAHA_*`, HMAC ≥ 32 bytes, ruta del webhook), `.env.example`, `infra/servicios.yml` (sin webhook global, imagen `devlikeapro/waha:latest-2026.8.1`), `apps/api/src/auth/app-auth.module.ts`.
- **Tests:** `waha-normalize`, `waha-signature`, `waha-provider`, `inbound-worker`, `waha-inbound` (e2e) y fixtures inventados en `apps/api/test/fixtures/whatsapp/waha/`.
- **Docs:** `docs/decisiones.md` (#22 a #27, "Para la tarea 008", deuda de la 004) y `docs/entorno-dev.md`.

### Verificación

1. Firma válida → 200; ausente, inválida, otro algoritmo o cuerpo alterado → 401 sin detalles; más de 1 MB → 413. ✅
2. Forma inválida → 400; `presence.update` → 200 sin trabajo en la cola. ✅
3. Normalización con fixtures: texto, imagen con epígrafe, audio, ubicación, video, documento y sticker; `fromMe`, grupo, estado y newsletter ignorados; `@c.us` → E.164; `@lid` con y sin número. ✅
4. Evento firmado → trabajo → 1 mensaje con el `tenant_id` del canal, contacto y conversación creados, `sent_at` del payload y `raw` completo. ✅
5. Mismo evento dos veces → 1 mensaje; `last_message_at` y `updated_at` de la conversación sin cambios. ✅
6. Segundo mensaje → misma conversación y mismo contacto. ✅
7. Carrera: 10 rondas de dos trabajos en paralelo del mismo contacto nuevo → 1 contacto y 1 conversación abierta. ✅
8. Aislamiento: dos empresas creadas por el test (no las demo, para no dejar datos) y el mismo número en las dos → cada mensaje solo es visible en la suya. ✅
9. Sesión desconocida → 200, nada guardado, log `descartado`, `retry_count = 0`. ✅
10. `session.status` WORKING → `channels.status = connected`. ✅
11. `ventas_auth` sin `USAGE` en `pgboss`; `ventas_app` sin `CREATE` en ningún schema ni `ALTER`/`DROP` sobre las tablas de pg-boss. ✅
12. Logs de 4 y 5 sin teléfono, texto ni nombre; los errores que guarda la cola llevan solo el código. ✅
13. Prueba real con el número de prueba en `ceramicos-demo`: canal `connected`; un texto, dos fotos con epígrafe y un audio guardados una vez cada uno; 1 contacto y 1 conversación; 7 trabajos completados sin reintentos. El remitente llegó como `@lid` con el número en `_data.key.remoteJidAlt` → `wa_id` en E.164. ✅
14. `git status` sin el archivo de secretos. ✅

`npm run test`: 129 tests en verde en dos corridas seguidas; `npm run lint` y `npm run typecheck` limpios.

Durante la prueba real apareció un problema: la sesión se creó con un `WAHA_WEBHOOK_URL` viejo, sin `/api`, y los webhooks daban 404. Se corrigió con una validación de la ruta al arrancar y con el script `dev:sync-channel-webhook`, que reaplica la configuración sin volver a escanear el QR.

### Revisores

- **revisor-codigo:** aprobado en 3 rondas, sin bloqueantes. Corregido por sus hallazgos: reintentos (de ~2,5 a ~25 min, migración 0005, log `fallido`), tope del timestamp, errores sin parámetros en `pgboss.job.output`, test de duplicados con `updated_at`, nombre del token del registro de proveedores, prefijo sin distinguir mayúsculas, código del error en el log, test de la configuración de la cola, tests de `createSession`/`updateSession` y el chequeo que corta el e2e si hay otra API corriendo. Sin corregir (menores): tests de `withTenantTransaction` y de los scripts de desarrollo, que se probaron a mano.
- **revisor-seguridad:** aprobado en 3 rondas, sin CRÍTICO, ALTO ni MEDIO. Corregido: U+0000 que rompía el encolado, canal resuelto antes de consultar LIDs a WAHA, webhook global sin firma fuera de infra y `new URL` sin protección en la validación del entorno. Queda como deuda: replay de `session.status`, una sola clave HMAC para todas las sesiones, `pgboss.job` sin RLS (aceptado), la API escuchando en todas las interfaces (deuda de la 002) y fijar la imagen de WAHA también por digest (opcional, toca infra).

### Decisiones tomadas

#22 pg-boss (schema, grants, retención, reintentos) · #23 firma HMAC y cuerpo crudo · #24 formato de `contacts.wa_id` con LIDs (confirmado con un payload real) · #25 rutas de proveedores y módulo `jobs` · #26 infra de WAHA · #27 número del canal desde el escaneo del QR (tarea 008).
