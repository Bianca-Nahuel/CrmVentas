# Tarea 014: bandeja y grilla de leads (ver, asignar números y reactivar la IA)

## Contexto

El panel ya tiene login, empresa activa, layout por rol y el sistema de diseño (tarea 023). Las secciones
Conversaciones y Leads son páginas "próximamente". Los datos ya están en la base: conversaciones con puntaje,
nivel, derivación y resumen, y los mensajes con quién los mandó.

Esta es la primera de tres tareas de la bandeja, que van en este orden:

1. **014 (esta):** ver.
   - grilla de leads;
   - detalle de la conversación (solo lectura);
   - asignar números a vendedores;
   - visibilidad por número;
   - reactivar la IA.
2. **024:** responder por WhatsApp desde el panel.
3. **025:** actualización en tiempo real (SSE).

Spec: `docs/specs/bandeja-y-leads.md`, que define quién ve qué, la grilla, la conversación y el resumen no
verificado. Referencias: `.claude/rules/frontend.md`, `.claude/rules/backend.md`,
`.claude/rules/base-de-datos.md`, `docs/decisiones.md` (#68, y la deuda de la 006 sobre `handoff_summary`)
y el "Resultado" de la 023.

## Objetivo

- **Owner y admin:** ven todas las conversaciones de la empresa.
- **Seller:** ve solo las de los números que tiene asignados. La regla la aplica el backend en cada
  endpoint.
- **Grilla de leads:** ordenable, filtrable y paginada en el servidor. En el celular, lista de tarjetas.
- **Conversación:** se abre con el resumen marcado como no verificado.
- **Números y vendedores:** el owner y el admin asignan números a vendedores desde una pantalla simple.
- **Reactivar la IA:** se puede en una conversación derivada.

## Antes de empezar

1. Leé la spec, el skill `ejecutar-tarea`, `migracion-db` (hay tabla nueva) y la skill `angular-developer`
   (las reglas del proyecto mandan sobre la skill).
2. Verificá que la 023 esté commiteada y que el panel levante (`npm run dev:web`).
3. **OpenAPI:** la regla vigente es que, hasta esta tarea, los tipos van en `libs/shared` y el HTTP se
   escribe a mano. Proponé cómo exponer OpenAPI desde Nest y qué generador de cliente usar para Angular,
   con versión, licencia y tamaño. Por ejemplo, `@nestjs/swagger` con `openapi-typescript` +
   `openapi-fetch`, o `ng-openapi-gen`. **No instales nada sin mi OK.**
4. Proponé dónde aplicar la visibilidad por número: política RLS que mire `app.user_id` y el rol, o filtro
   en el servicio, o las dos cosas. Justificalo.

## Pasos / requisitos

### 1. Base: asignación de números a vendedores

- **Tabla `channel_members`:**
  - columnas: `tenant_id`, `channel_id`, `user_id`, `created_at`, `created_by`;
  - PK o UNIQUE sobre `(channel_id, user_id)`;
  - FKs compuestas a `channels` y a `memberships` dentro de la misma empresa;
  - RLS con `ENABLE` + `FORCE` y grants explícitos para `ventas_app`.
- **Registro de la reactivación de la IA:** quién la reactivó y cuándo, sea en columnas de `conversations`
  o en una tabla de eventos. Proponé cuál.
- **Seed:**
  - asignar el número de Cerámicos a `multi@example.test` (seller);
  - sumar un seller sin números asignados, para probar el estado vacío.

### 2. API

Todos los endpoints corren con `TenantGuard`, en la transacción con RLS y con el permiso de `libs/shared`
que corresponda.

- **`GET /api/leads`:** grilla de la spec.
  - filtros: `tier`, `status`, `channelId` y `q`;
  - orden: `sort` y `dir`, con el orden por defecto de la spec;
  - paginación: cursor o página, con tamaño máximo acotado;
  - con índices para el orden por puntaje y por último mensaje.
- **`GET /api/conversations/:id`:** detalle.
  - contacto, canal, puntaje y nivel;
  - `score_breakdown`, `extracted_data`, `handoff_reason` y `handoff_summary`;
  - estado de la IA.
- **`GET /api/conversations/:id/messages`:** mensajes paginados hacia atrás. **Nunca** devuelve `raw` ni
  `media_key`.
- **`POST /api/conversations/:id/reactivate-ai`:**
  - lo pueden usar owner, admin y el seller del número;
  - borra `handed_off_at` y `ai_paused_until` y registra quién lo hizo;
  - es idempotente.
- **`GET /api/channels`:** números de la empresa con sus vendedores asignados (owner y admin).
- **`PUT /api/channels/:id/members`:** reemplaza la lista de vendedores de un número (owner y admin).
  - solo se pueden asignar membresías activas con rol `seller` de la misma empresa;
  - lo que no cumpla responde 400.
- **Visibilidad:**
  - seller: lista, detalle, mensajes y reactivar solo para los números asignados;
  - conversación de otro número → **404**;
  - viewer → 403.
- **Datos de los mensajes:** DTOs validados, sin datos personales en los logs, y el texto de los mensajes se
  devuelve como dato, sin transformar.
- **OpenAPI:** según la opción aprobada. Los tipos del panel salen del cliente generado.

### 3. Panel

- **Leads (`/leads`):**
  - escritorio: tabla sobre `cdk-table`, con `app-sort-header`, filtros (nivel, estado, número y búsqueda
    con espera antes de consultar) y paginador;
  - celular: tarjetas con `app-score` compacto;
  - el orden, los filtros y la página quedan en la URL (query params), para poder compartir y volver;
  - estados de carga, vacío (con el caso del seller sin números) y error.
- **Conversaciones (`/conversaciones`):** bandeja con dos paneles en escritorio (lista + conversación). En
  el celular, la lista y la conversación van a pantalla completa, con un botón para volver.
- **Conversación (`/conversaciones/:id`):**
  - mensajes con burbujas por tipo de remitente (cliente, IA, equipo, sistema);
  - fecha agrupada por día, con locale es-AR;
  - el texto siempre como texto, con saltos de línea y sin links clickeables;
  - cabecera: contacto, número, `app-score` (variante `full`) y estado de la IA;
  - panel de derivación con el aviso **"Resumen automático, no verificado"**, el motivo y los datos
    extraídos;
  - botón **"Volver a activar la IA"** (con confirmación) cuando está derivada o pausada.
- **Números y vendedores:** una sección chica, solo para owner y admin. Puede ir como página propia o dentro
  de Canales, pero no reemplaza la 011. Lista los números de la empresa y deja asignar o quitar vendedores
  con un selector accesible (CDK).
- **Menú:** la sección nueva se ve según los permisos de `libs/shared`. Si hace falta un permiso nuevo (por
  ejemplo `channel: ['assign']`), se agrega en `libs/shared` para la API y el panel por igual.
- **Accesible:**
  - la tabla con `aria-sort`;
  - la lista de mensajes con roles adecuados;
  - foco visible y teclado;
  - contraste AA en claro y oscuro.

## Criterios de aceptación

- [ ] Un seller con el número de Cerámicos asignado ve sus conversaciones, y no ve las de un número que no
      tiene: la lista no las trae y el detalle por URL da 404.
- [ ] Al quitarle el número, el pedido siguiente ya no las devuelve.
- [ ] Un seller sin números ve el estado vacío.
- [ ] El viewer no entra a Leads ni a Conversaciones (403 en la API, "sin acceso" en el panel).
- [ ] La grilla ordena, filtra y pagina en el servidor, y el estado queda en la URL.
- [ ] La conversación muestra el resumen marcado como no verificado. El texto de un mensaje con HTML o
      `<script>` se ve literal.
- [ ] Reactivar la IA borra la derivación, queda registrado quién lo hizo y la IA vuelve a responder el
      próximo mensaje.
- [ ] El owner y el admin asignan y quitan vendedores; un seller no puede (403).
- [ ] Se ve bien a 375 px y a 1280 px, en claro y oscuro.
- [ ] `npm run test`, `npm run lint`, `npm run typecheck`, `npm run build` y `npm run e2e:web` pasan.

## Verificación (obligatoria)

1. **Tests e2e de la API** (Postgres local), con un seller asignado a A y no a B:
   - `GET /api/leads` solo trae los de A;
   - `GET /api/conversations/<de B>` da 404, y lo mismo sus mensajes y su reactivación;
   - el viewer recibe 403.
2. **Quitar la asignación** → el pedido siguiente del seller ya no ve A.
3. **Aislamiento entre empresas:** un owner de otra empresa recibe 404 en las conversaciones de esta (RLS).
4. **`PUT /api/channels/:id/members`:**
   - con un viewer, un admin, una membresía desactivada o un usuario de otra empresa → 400;
   - llamado por un seller → 403.
5. **Mensajes:** la respuesta no trae `raw` ni `media_key`. Hay un test que lo afirma.
6. **Reactivar la IA:**
   - en una conversación derivada → `handed_off_at` y `ai_paused_until` en NULL y queda el registro de
     quién;
   - un mensaje entrante después dispara una corrida de `ai-reply` (en el test, con el modelo simulado).
7. **Playwright:**
   - el owner ordena por puntaje y filtra por nivel, y la URL refleja el estado;
   - el seller ve solo sus conversaciones;
   - con la URL de una conversación ajena, el seller termina en "no encontrada";
   - reactivar la IA desde la conversación funciona.
8. **Contenido no confiable:** un mensaje con `<img src=x onerror=alert(1)>` y `*negrita*` se ve literal en
   la conversación. Playwright lo afirma con el texto visible y sin elementos `img` en esa burbuja.
9. **Capturas** de la grilla, la bandeja, la conversación con resumen derivado y la sección de números y
   vendedores, en claro y oscuro, a 375 px y 1280 px. Me las mostrás antes de cerrar.
10. **Calidad:** `npm run lint` (incluye el autochequeo de seguridad), `typecheck`, `test`, `build` y
    `e2e:web` pasan. El bundle inicial sigue bajo el límite de 500 kB.
11. **`git status`:** sin `.env`.

## Fuera de alcance

- Responder desde el panel (tarea 024) y el tiempo real (tarea 025). Acá la bandeja se actualiza al
  navegar o con un botón de "actualizar".
- Conectar números por QR y la pantalla completa de Canales (tarea 011).
- Etiquetas y categorización de clientes (021), embudo y métricas (013), notificaciones.
- Asignar conversaciones a un vendedor puntual (la asignación es por número).
- Mostrar imágenes, audios y archivos (se muestra el tipo de mensaje con un texto; los medios van con
  018 y 022).
- Editar el puntaje a mano o cambiar reglas del agente. Las reglas y los prompts se están rediseñando
  (decisión #67): esta tarea no las toca.

## Entregable

Resumen:

- generador de OpenAPI elegido y su porqué;
- dónde se aplica la visibilidad y por qué;
- migración nueva;
- endpoints;
- resultado de cada punto de la verificación, con las capturas;
- veredicto de `revisor-codigo` y `revisor-seguridad`;
- decisiones nuevas en `docs/decisiones.md`;
- mensaje de commit propuesto.

## Resultado

_Hecha el 2026-10-30 en la rama `claude/bandeja-y-leads` (sale de `claude/panel-angular-base`)._

### Decisiones (ver `docs/decisiones.md` #76 a #80)

- **OpenAPI (#76):**
  - contratos zod en `apps/api/src/inbox/*.contracts.ts` (los mismos que validan con `ZodValidationPipe`);
  - `@asteasolutions/zod-to-openapi` 9.1.0 (MIT, dev) genera `apps/api/openapi.json` (OpenAPI 3.1);
  - `ng-openapi-gen` 1.1.0 (MIT, dev) genera el cliente sobre `HttpClient` en `apps/web/src/app/api/generated/`, commiteado;
  - `npm run api:generate` los regenera y `npm run lint` falla si quedaron viejos.
- **Visibilidad por número (#77):** en el servicio (`ConversationScope`, 404) y en la base (políticas RLS `AS RESTRICTIVE` `channel_visibility`).
  - `read_all` pasa a significar "todos los números" y el seller lo pierde.
  - Opción `inbox.sellers_see_all_channels` en la config de la empresa.
- **Reactivar la IA (#78):**
  - registro en `conversation_events`;
  - reinicia `qualification_turns` y `hot_turns`;
  - el worker cuenta `asked_fields`/`asked_text` desde la última reactivación;
  - las claves de los textos fijos llevan la cantidad de reactivaciones (`handoff:<id>:<n>`, `media-ask:<id>:<n>`).
- **Panel (#79):**
  - helper `core/query.ts` en lugar de `rxResource`;
  - Leads, bandeja y números en un solo módulo lazy;
  - refresco cada 30 s con la pestaña visible.
- **Endpoints extra (#80):** `GET /api/leads/summary` y `GET /api/members/sellers`.
- **Ajustes después de la prueba del usuario (#82):**
  - bandeja por prioridad: primero las que esperan a una persona; después calor y espera por igual;
  - filtros "Sin responder" y "Sin ver";
  - "sin ver" por persona: tabla `conversation_reads` (migraciones 0016 y 0017) y `POST /api/conversations/:id/read`;
  - fila completa clickeable en Leads;
  - resumen a la derecha del chat desde 1280 px;
  - rediseño de Números y vendedores.
- **Tabla nativa (#81):** la grilla de Leads usa `<table>` con `@for` en lugar de `cdk-table`, para quedar por debajo de 500 kB. Lo eligió el usuario.

### Migraciones

- **`0014_inbox_tables`:**
  - `channel_members` (PK `(channel_id, user_id)`);
  - `conversation_events`;
  - UNIQUE `(tenant_id, id)` en `conversations`;
  - índice por puntaje.
- **`0015_inbox_permissions_rls`:**
  - FKs compuestas a `memberships`;
  - grants (`channel_members` SELECT/INSERT/DELETE, `conversation_events` SELECT/INSERT);
  - RLS con `ENABLE` + `FORCE`;
  - `app_sees_all_channels()` y `app_visible_channel_ids()`;
  - políticas RESTRICTIVE en `conversations`, `messages`, `outbound_messages`, `ai_runs` y `conversation_events`.

### Endpoints

| Endpoint                                    | Permiso              | Seller           | Viewer |
| ------------------------------------------- | -------------------- | ---------------- | ------ |
| `GET /api/leads`                            | `lead:read`          | solo sus números | 403    |
| `GET /api/leads/summary`                    | `lead:read`          | solo sus números | 403    |
| `GET /api/conversations/:id`                | `conversation:read`  | 404 si es ajena  | 403    |
| `GET /api/conversations/:id/messages`       | `conversation:read`  | 404 si es ajena  | 403    |
| `POST /api/conversations/:id/reactivate-ai` | `conversation:reply` | 404 si es ajena  | 403    |
| `GET /api/channels`                         | `channel:read`       | 403              | 403    |
| `PUT /api/channels/:id/members`             | `channel:assign`     | 403              | 403    |
| `GET /api/members/sellers`                  | `channel:assign`     | 403              | 403    |

### Archivos

- **API:**
  - `src/inbox/*` (módulo nuevo);
  - `src/http/zod-validation.pipe.ts` y `src/http/api-route.ts`;
  - `@RequirePermission` en `src/auth/decorators.ts`, evaluado en `src/auth/tenant.guard.ts`;
  - `src/db/schema/inbox.ts`, `messaging.ts` (UNIQUE e índice) y `pools.ts`;
  - `src/ai/reply/ai-reply.service.ts` (solo claves y conteo);
  - `scripts/openapi.ts` y `scripts/seed.ts`;
  - `test/inbox-api.test.ts` (nuevo) y `test/ai-reply.test.ts`.
- **`libs/shared`:** `auth/permissions.ts` (`channel:assign`, `roleCan`, `TenantPermission`) y `ai/tenant-config.ts` (bloque `inbox`).
- **Panel:**
  - `src/app/api/` (cliente generado e `inbox-api.ts`);
  - `src/app/pages/{leads,inbox,channels}` y `pages/inbox.routes.ts`;
  - `core/{query,poll,inbox-summary}.ts`;
  - `ui/confirm-dialog.ts` y aviso con tono de éxito;
  - menú, número de derivadas en el menú y rutas;
  - unitarios: `format.spec`, `lead-query.spec` y `nav.spec`;
  - e2e: `inbox.spec` y capturas.
- **Tooling:**
  - `tools/check-api-client.mjs`;
  - scripts `api:*`;
  - ESLint y Prettier ignoran el código generado.
- **Docs:** `docs/decisiones.md`, `.claude/rules/frontend.md` y `CLAUDE.md`.

### Verificación

1. **Seller A/B:** ✔. `GET /api/leads` trae solo A. El detalle, los mensajes y reactivar en B dan 404. El viewer recibe 403 en todo.
2. **Quitar la asignación:** ✔. El pedido siguiente ya no ve A y responde `noChannels`.
3. **Otra empresa:** ✔. 404 por RLS.
4. **`PUT /api/channels/:id/members`:** ✔.
   - viewer, admin, membresía desactivada, usuario de otra empresa, repetido o inexistente → 400;
   - seller → 403;
   - número de otra empresa → 404.
5. **Mensajes:** ✔. No traen `raw` ni `media_key` y cada mensaje tiene exactamente las claves esperadas.
6. **Reactivar:** ✔.
   - `handed_off_at` y `ai_paused_until` quedan en NULL, los contadores en 0 y queda el evento con quién;
   - es idempotente;
   - el entrante siguiente corre `ai-reply` (con el modelo simulado) y responde;
   - derivar → reactivar → derivar manda dos textos fijos, y lo mismo con `media-ask`.
7. **Playwright:** ✔ 65/65.
   - ordenar y filtrar con el estado en la URL;
   - el seller ve solo lo suyo;
   - la URL ajena termina en "no encontrada";
   - reactivar con confirmación;
   - asignar con el selector;
   - el estado vacío y el viewer.
8. **Contenido no confiable:** ✔. `<img src=x onerror=alert(1)> y *negrita*` se ve literal, sin `img`, `a`, `b` ni `strong`, y sin diálogos.
9. **Capturas:** 44 en `apps/web/test-results/capturas/` (09 a 15 son las de esta tarea), en claro y oscuro, a 375 y 1280 px. El usuario las aprobó ✔.
10. **Calidad:** lint, typecheck y build ✔. API 625/625 y panel 72/72. El bundle inicial pesa **491,7 kB** (límite 500 kB): con `cdk-table` pesaba 505,5 kB, y el usuario eligió cambiarla por una tabla nativa (decisión #81).
11. **`git status`:** sin `.env` ✔.

Después de los ajustes del usuario (#82): API 633/633 (prioridad, espera, filtros, "sin ver" por persona y su RLS), panel 73/73, e2e de la bandeja 12/12 (fila clickeable, orden, punto de sin ver, filtros), lint, typecheck y build OK; bundle inicial de 493,1 kB.

Las opciones de `sellers_see_all_channels` en `true` y `false` también tienen test, por API y por RLS directa.

### Revisores

- **`revisor-seguridad`: APROBADO.** Solo hallazgos BAJO, aplicados o documentados:
  - el cursor ahora se valida como ISO completo (antes daba 500 con `"1"`);
  - `contacts` fuera de la RLS por número, `q` en los access logs y la confianza de la RLS en `insertVersion`, anotados en la deuda;
  - se agregó `conversation_events: 0` al assert del test.
- **`revisor-codigo`: APROBADO en la segunda ronda.** En la segunda ronda marcó cinco menores, aplicados:
  - un regex de UUID estricto en el cursor, con test;
  - "Limpiar filtros" cancela la búsqueda pendiente;
  - el comentario de `app-sort-header` ya no habla de `cdk-table`;
  - un test de que reasignar conserva quién asignó;
  - se revirtió el reformateo que quedaba en `catalog-unit.test.ts`.

  Queda sin test unitario propio `query.loadFailed`; lo cubren los e2e.

- **`revisor-codigo`, primera ronda: CAMBIOS REQUERIDOS.** El único bloqueante era el bundle, resuelto con la tabla nativa (decisión #81). Corregido además:
  - un refresco que falla mantiene lo que se veía;
  - el timer de búsqueda se cancela al salir y el campo sigue a la URL al volver atrás;
  - el PUT solo cambia lo que cambió (conserva quién asignó);
  - `clock_timestamp()` en el evento de reactivación;
  - aviso "Se muestran las 50 más recientes" en la bandeja;
  - la región `aria-live` quedó acotada a un texto de estado;
  - los valores no escalares se muestran con `JSON.stringify`;
  - se revirtió el reformateo de archivos fuera de la tarea.
- **Sin aplicar:** el ruido de Prettier en la tabla de `docs/decisiones.md` (pasa en cada cambio de la tabla). `tools/panel-pruebas/empresas.local.json` y `.claude/launch.json` quedan fuera del commit.
