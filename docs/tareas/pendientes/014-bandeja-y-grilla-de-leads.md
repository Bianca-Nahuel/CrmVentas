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
