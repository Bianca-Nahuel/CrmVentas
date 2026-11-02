# Tarea 027: panel de catálogo (subir el Excel) y panel de configuración del agente

## Contexto

El catálogo (importación de Excel, lectura de la página de cada producto, extractor, marcas de precio) y la
configuración del agente (`tenant_configs`, versionada y validada con zod en `libs/shared`) ya existen, pero
solo se manejan por scripts (`dev:import-catalog`, `dev:test-extractor`, `dev:set-config`). En el panel,
**Catálogo** y **Configuración del agente** siguen en "próximamente".

Esta tarea hace los dos paneles, para que el `owner` o el `admin` de cada empresa los maneje solo.

Referencias: `CLAUDE.md`, `.claude/rules/*`, skill `angular-developer`, `docs/decisiones.md`, el schema de
`libs/shared/src/ai/tenant-config.ts` y `catalog-config.ts`, el servicio de importación y el
`ProductPageReader` del catálogo, y el `reply-engine` del agente.

## ⚠️ Tests: en esta tarea no se escriben ni se corren `npm run test` ni `npm run e2e:web`

Por decisión del usuario:

- **No** escribas tests nuevos de Vitest ni de Playwright, y **no** corras `npm run test` ni `npm run e2e:web`.
- **Sí** corré `npm run lint`, `npm run typecheck` y `npm run build`, que tienen que pasar.
- La verificación es **manual**: vos con `curl` contra la API levantada (punto A) y yo en el navegador
  (punto B).
- Los revisores `revisor-codigo` y `revisor-seguridad` **se lanzan igual** al final.
- Si algún cambio rompe un test existente, no lo arregles ni lo borres: anotalo en el resultado de la tarea
  para resolverlo después.

## Objetivo

- **Catálogo:** subir el Excel, mapear columnas, ver la vista previa con los cambios, aplicar, volver
  atrás, ver los productos con su último precio y configurar el catálogo y el extractor, con un botón para
  probarlo.
- **Agente:** editar todas las secciones de la configuración con formularios, guardar versiones, ver el
  historial, comparar y restaurar, y **probar el agente** con un chat de prueba antes de guardar.

## Antes de empezar

1. Leé `CLAUDE.md`, las reglas, el skill `angular-developer` y el skill `ejecutar-tarea`, adaptando su paso
   de verificación a lo que dice esta tarea.
2. Revisá el servicio de importación del catálogo y el `reply-engine`, para **reutilizarlos** desde la API
   sin duplicar lógica.
3. Si necesitás alguna dependencia (por ejemplo para subir archivos en Nest o un editor de diferencias),
   proponela con tamaño, licencia y mantenimiento. **No instales nada sin mi OK.**

## Parte 1: panel de catálogo

### API

Permiso `catalog: ['update']` (`owner` y `admin`) en todo lo que modifica; `catalog: ['read']` para ver.

- **`POST /api/catalog/imports`** (multipart):
  - solo `.xlsx`: extensión, `content-type` y los primeros bytes de zip (`PK`), con el mismo tope de 5 MB
    y los mismos límites de descompresión del lector;
  - límite de tamaño aplicado **antes** de leer todo el cuerpo;
  - guarda el archivo temporalmente en la base (`catalog_import_files`: `bytea`, con vencimiento a las
    24 h, RLS y un trabajo que borra los vencidos), para poder rehacer la vista previa si se cambia el mapeo
    sin volver a subirlo;
  - devuelve los encabezados detectados, las primeras 10 filas, el mapeo sugerido (el último de la empresa o
    el autodetectado) y el id de la importación en `preview`.
- **`POST /api/catalog/imports/:id/preview`** con `{ mapping }`: rehace la vista previa con ese mapeo y
  devuelve los conteos (nuevos, cambiados, sin cambios, ausentes, inválidas, saltos de precio).
- **`GET /api/catalog/imports/:id/rows?change=&status=&page=`:** filas de la vista previa paginadas, con qué
  cambió de qué a qué y los errores por fila.
- **`POST /api/catalog/imports/:id/apply`** y **`POST /api/catalog/imports/revert`:** usan la lógica que ya
  existe (lock por empresa, `base_import_id`, etc.).
- **`GET /api/catalog/imports`:** historial con estado, conteos, archivo, quién y cuándo.
- **`GET /api/catalog/products?q=&active=&page=`:** productos con su último snapshot válido (precios,
  fecha, de dónde salió) y el link.
- **`GET /api/catalog/products/:sku`:** detalle con los atributos y los últimos snapshots.
- **`POST /api/catalog/products/:sku/refresh`:** fuerza una lectura de la página (respeta el límite por
  dominio y un límite por usuario).
- **`POST /api/catalog/extractor/test`** con `{ url, extractor? }`: prueba el extractor actual o uno
  borrador contra una URL. Reutiliza el `ProductPageReader` con **todas** las protecciones SSRF; solo
  dominios de `allowed_domains`; como mucho 10 pruebas por minuto por empresa. Devuelve los campos y de
  dónde salió cada uno, **nunca el HTML**.
- Configuración del catálogo: se guarda con el mismo endpoint de configuración del agente (Parte 2), porque
  vive en `tenant_configs.config.catalog`.

### Pantallas (ruta `/catalogo`, con pestañas)

1. **Productos:** búsqueda, filtro activos o inactivos, tabla (tarjetas en el celular) con SKU, nombre,
   categoría, unidad, último precio con su fecha y origen, y link. Al abrir uno: atributos, snapshots y un
   botón "Actualizar precio".
2. **Importar** (asistente en tres pasos):
   - **Subir:** zona para arrastrar el archivo y un botón; muestra los límites ("hasta 5 MB y 5.000 filas,
     solo .xlsx").
   - **Mapear columnas:** por cada campo (SKU y nombre obligatorios; link, categoría, unidad, m² por caja,
     precio y stock opcionales), un selector con los encabezados del archivo y las primeras filas como
     ejemplo. Aviso: "Las demás columnas se guardan como atributos". Botón "Ver cambios".
   - **Revisar y aplicar:** conteos, saltos de precio de más del 40 % destacados, filtro por tipo de cambio,
     filas inválidas con su motivo en lenguaje claro ("el link no es del dominio configurado"), y "Aplicar" con
     confirmación. Si la importación quedó vieja (otra se aplicó en el medio), mensaje claro y botón para
     rehacer la vista previa.
3. **Historial:** importaciones con su estado, y "Volver a la anterior" con confirmación.
4. **Configuración:**
   - dominios permitidos (con el aviso de la variante con y sin `www`);
   - qué precio citar, origen del precio, antigüedad máxima, salto máximo, fuente de disponibilidad;
   - sinónimos y atributos clave;
   - **extractor:** una regla por campo (selector, atributo, posición, expresión regular, tipo de dato),
     y un campo con la URL de un producto más el botón **"Probar"**, que muestra lo que extrae cada regla
     **antes de guardar**.

## Parte 2: panel de configuración del agente

### API

Permiso `config: ['update']` (`owner` y `admin`).

- **`GET /api/agent-config`:** la versión vigente, con su número, quién la guardó y cuándo.
- **`PUT /api/agent-config`** con `{ config, expectedVersion }`:
  - valida con el **mismo** zod de `libs/shared` y devuelve los errores con la ruta del campo;
  - si `expectedVersion` no es la vigente → **409** (otra persona guardó en el medio); el panel ofrece
    recargar y comparar;
  - inserta una versión nueva, nunca edita.
- **`GET /api/agent-config/versions`** y **`GET /api/agent-config/versions/:version`:** historial y una versión.
- **`POST /api/agent-config/versions/:version/restore`:** crea una versión nueva copiando esa.
- **`GET /api/agent-config/models`:** los modelos de `ALLOWED_MODELS` con su precio, para el selector.
- **`POST /api/agent-config/playground`:** chat de prueba (ver más abajo).
- Lo sensible sigue en el backend: el `owner` es el único que puede activar la revisión de calidad
  (con la confirmación de transparencia); el resto de los campos los edita también el `admin`.

### Pantallas (ruta `/agente`, con secciones en la barra lateral interna o en pestañas)

Formularios con **Signal Forms** (Angular 22), validados en el navegador con el mismo zod y, al guardar,
con los errores del servidor ubicados en su campo.

1. **General:** IA activada, números donde responde y modelo (selector con el precio estimado por
   conversación).
2. **Negocio:** nombre, rubro, sucursales con su horario semanal (editor de franjas por día), horario de
   atención, medios de pago, envíos, web y email.
3. **Conocimiento:** preguntas frecuentes (agregar, editar, reordenar, borrar) y políticas.
4. **Personalidad y reglas:** nombre y tono del asistente, instrucciones libres (contador de caracteres),
   reglas de negocio, ofertas, cosas que nunca debe hacer y guía de sugerencias de venta.
5. **Calificación:** campos a obtener (tipo, cómo preguntarlo, obligatorio, prioridad, desde qué
   puntaje), guía de descubrimiento en texto libre, preguntas por mensaje y límites de turnos.
   - Aviso visible si un campo pide un dato bloqueado (DNI, tarjeta, CBU...), antes de que lo rechace el servidor.
6. **Puntaje:** dimensiones con su descripción y peso, peso de la completitud y umbrales de caliente y
   tibio, con una **vista de ejemplo** que muestra cómo quedaría el puntaje con señales de prueba (cálculo
   en el navegador con la misma función pura, compartida desde `libs/shared` si hoy está en la API).
7. **Derivación:** disparadores (activado y modo, inmediato o "primero pedir estos datos", con su texto de
   introducción), disparadores propios, palabras extra y excluidas, textos fijos de derivación en horario y
   fuera de horario, y qué hacer con audios e imágenes.
8. **Bandeja y revisión:** vendedores ven todos los números o solo los suyos, cierre automático por
   inactividad, y la configuración del analista de calidad (criterios, guía, tope diario, modelo), con la
   confirmación de transparencia del `owner`.

**En todas las secciones:**

- botón "Guardar" fijo abajo, con el resumen de cambios sin guardar y aviso al salir de la página con cambios pendientes;
- ayuda corta en cada campo, en lenguaje de negocio, sin términos técnicos;
- **Historial:** lista de versiones (número, quién y cuándo), comparación entre dos versiones campo por
  campo (en texto, sin `innerHTML`) y "Restaurar esta versión" con confirmación.

### Probar el agente (playground)

- Panel lateral o pantalla con un chat donde el `owner` o el `admin` escribe como si fuera un cliente.
- Usa la configuración **en edición, todavía sin guardar** (validada con zod antes de correr) y el **mismo**
  `reply-engine` que el worker, con las herramientas del catálogo de la empresa.
- Muestra la respuesta tal como le llegaría al cliente (con las marcas ya renderizadas) y, desplegable:
  puntaje con su desglose, nivel, campos extraídos, disparadores, decisión (responder, derivar o nada),
  resumen de derivación y controles que bloquearon algo.
- **No envía nada por WhatsApp, no crea conversaciones ni toca la base de negocio.** Solo registra el costo
  en `ai_runs` marcado como `playground` (o en una tabla propia), para que cuente en el consumo.
- Límites: conversación de prueba de hasta 20 mensajes, 30 turnos por hora por empresa, y respeta
  `AI_ENABLED` y el `AiBudgetGuard`.
- Botón "Empezar de nuevo" y simulación de "fuera de horario" (un selector de hora).

## Seguridad (los revisores lo van a mirar)

- Toda la validación de la config y del Excel ocurre en el servidor; el navegador solo ayuda.
- Subida de archivos: límite antes de leer, tipo verificado por contenido, sin guardar el archivo en disco y con vencimiento.
- El probador del extractor usa las mismas protecciones SSRF que el lector y nunca devuelve HTML.
- Ningún texto de la config, del Excel ni del playground se muestra con `innerHTML`.
- El playground no puede usarse para mandar mensajes ni para leer conversaciones reales.
- Logs: solo ids y códigos, nunca el contenido de la config, del Excel ni de los mensajes de prueba.

## Criterios de aceptación

- [ ] Un `owner` puede subir un Excel, mapear las columnas, revisar los cambios, aplicarlos y volver atrás, sin usar scripts.
- [ ] Puede configurar el extractor y probarlo contra una URL real antes de guardarlo.
- [ ] Puede editar cualquier parte de la configuración del agente, ver el historial, comparar y restaurar versiones.
- [ ] Puede probar el agente con la configuración sin guardar, sin que se envíe nada por WhatsApp.
- [ ] Un `seller` o un `viewer` no ve estas secciones y la API le responde 403.
- [ ] `npm run lint`, `npm run typecheck` y `npm run build` pasan.

## Verificación (manual; sin `npm run test` ni `npm run e2e:web`)

### A. La hace el agente, con la API levantada y `curl`

1. Subir un `.xlsx` válido → encabezados, filas de ejemplo y mapeo sugerido.
2. Subir un `.csv` renombrado a `.xlsx`, un archivo de más de 5 MB y un zip que no es Excel → rechazados con
   un mensaje claro, sin leer el archivo entero.
3. Cambiar el mapeo y rehacer la vista previa sin volver a subir; aplicar; volver atrás.
4. `extractor/test` con una URL de otro dominio, con `http://` o que resuelve a una IP privada → rechazado.
5. `PUT /api/agent-config` con una config inválida (campo DNI, peso negativo) → 400 con la ruta del campo;
   con `expectedVersion` vieja → 409.
6. Restaurar una versión → se crea una versión nueva.
7. Playground: responde con la config enviada, no aparece ninguna fila nueva en `messages`,
   `conversations` ni `outbound_messages`, y el costo queda registrado; pasado el límite por hora → 429.
8. Con un `seller` y un `viewer`: todos los endpoints de esta tarea → 403.
9. `npm run lint`, `npm run typecheck` y `npm run build` → pasan. `git status` sin `.env`.

### B. La hago yo en el navegador (dejame una lista paso a paso)

- importar el Excel de 5 productos de Lecer de punta a punta;
- configurar el extractor con una página real y probarlo;
- cambiar el tono, agregar una regla y una pregunta frecuente, y probarlo en el playground;
- cambiar un umbral y ver la vista de ejemplo del puntaje;
- comparar dos versiones y restaurar una;
- revisar todo en el celular y en modo oscuro.

## Fuera de alcance

- Tests automáticos nuevos (decisión del usuario para esta tarea).
- Google Sheets, integración con sistemas de gestión y rastreo de la web.
- Editar productos uno por uno desde el panel (se hace con el Excel).
- Cargar claves propias de Anthropic u OpenAI (va con la tarea de claves propias).

## Entregable

Resumen: endpoints nuevos, pantallas, dependencias instaladas (si hubo), resultado de cada punto de la
verificación A, la lista paso a paso para la verificación B, tests existentes que se hayan roto (si hubo),
veredicto de `revisor-codigo` y `revisor-seguridad`, decisiones nuevas en `docs/decisiones.md` y mensaje de
commit propuesto.

## Resultado

Hecha el 2026-11-02 en la rama `claude/test-tiempo-real`, **sin commitear**. Decisiones #113 a #117 y "Deuda pendiente (tarea 027)" en `docs/decisiones.md`.

### Endpoints nuevos

- Catálogo (`catalog.update` en todos): `POST /api/catalog/imports` (multipart), `POST /api/catalog/imports/:id/preview`, `GET /api/catalog/imports/:id/rows`, `POST /api/catalog/imports/:id/apply`, `POST /api/catalog/imports/revert`, `GET /api/catalog/imports`, `GET /api/catalog/products`, `GET /api/catalog/products/:sku`, `POST /api/catalog/products/:sku/refresh`, `POST /api/catalog/extractor/test`.
- Agente (`config.update` en todos): `GET` y `PUT /api/agent-config`, `GET /api/agent-config/versions`, `GET /api/agent-config/versions/:version`, `POST /api/agent-config/versions/:version/restore`, `GET /api/agent-config/models`, `POST /api/agent-config/playground`.

### Archivos

- **Migraciones:** `0026_paneles_catalogo_agente.sql` (`catalog_import_files`, `ai_playground_runs`), `0027_paneles_catalogo_agente_rls.sql` (FKs, grants, RLS, DELETE de filas solo en preview, función de purga, cola `catalog-import-files-purge`) y `0028_purga_vistas_previas.sql` (la purga también borra las vistas previas de más de 24 h). Aplicadas en la base local.
- **libs/shared:** subpath `@ventas/shared/ai` (`ai/index.ts`), `ai/score.ts` (movido desde la API, que lo reexporta), `ai/messages.ts` (mensajes de validación en lenguaje de negocio) y `review.transparency_ack` en `ai/tenant-config.ts`.
- **API:**
  - catálogo: `catalog-admin.contracts.ts`, `.controller.ts` y `.service.ts`; `import-files-purge.worker.ts`; `read-only-catalog-store.ts`; `web/extractor-test.ts` (compartido con `dev:test-extractor`); `import/catalog-import.service.ts`, partido en `analyze`, `insertImport`, `replacePreview`, `insertRows` y `diffRows`;
  - agente: `ai/config/agent-config.contracts.ts`, `.controller.ts`, `.service.ts` y `playground.service.ts`; `TenantConfigService.validate` e `insertNextVersion`;
  - general: `http/window-limiter.ts`, `ApiRoute.errors` y `multipartFile` (OpenAPI), `useBusinessMessages()` en `bootstrap.ts`.
- **Panel:**
  - `pages/agent/*` (`/agente`: el borrador `AgentDraft`, las 8 secciones, el historial y el playground);
  - `pages/catalog/*` (`/catalogo`: Productos, Importar, Historial y Configuración);
  - `api/catalog-api.ts`, `api/agent-config-api.ts`, las rutas lazy y el cliente regenerado.
- **Dependencias:** `multer` 2.4.0 (ya venía con Nest; ahora es directa) y `@types/multer` 2.3.0 (dev).

### Verificación A (curl contra la API levantada)

1. **Subir un .xlsx válido:** OK, con los encabezados, las filas de ejemplo, el mapeo propuesto y los conteos. Con encabezados que no se reconocen, el mapeo vuelve en `null` junto con los encabezados para elegirlo.
2. **Archivos rechazados:**
   - un .csv renombrado da 400 `not_xlsx_csv`;
   - un zip que no es Excel da 400 `not_xlsx`;
   - uno de 6 MB da 413 `FILE_TOO_LARGE`. Se corta por el Content-Length antes de leer el cuerpo; sin Content-Length (chunked), lo corta multer.
3. **Mapeo, aplicar y volver atrás:** OK.
   - Rehacer la vista previa con otro mapeo usa el mismo id y no hace falta volver a subir el archivo.
   - Aplicar funciona; aplicar de nuevo da 409.
   - Una vista previa vieja da 409 `STALE_PREVIEW`; se rehace y se aplica bien.
   - Volver atrás funciona, y se ven el historial, los saltos de precio, las filas inválidas con su motivo y los ausentes.
4. **Probador del extractor:**
   - otro dominio da `url_domain`, `http://` da `url_not_https`, un host que resuelve a 127.0.0.1 da `ip_not_public` y una IP literal da `url_domain`;
   - un selector inválido da 400;
   - con una página real devuelve los campos y su origen, sin HTML (cero `<` en la respuesta);
   - pasadas 10 pruebas por minuto da 429;
   - si el borrador trae otro dominio, ahora se usan los dominios guardados y da `url_domain`.
5. **Config inválida:** un campo DNI y un peso negativo dan 400 `INVALID_CONFIG`, con la ruta de cada campo. Una `expectedVersion` vieja da 409 `VERSION_CONFLICT`.
6. **Restaurar:** crea una versión nueva; con una versión vieja da 409. La regla de transparencia: sin confirmar da 400; con la confirmación, el servidor escribe el ack e ignora el que se mandó.
7. **Playground:**
   - responde con la config enviada y con la hora simulada;
   - después de dos turnos reales solo se sumaron 2 filas en `ai_playground_runs`; `messages`, `conversations`, `outbound_messages`, `ai_runs` y `product_snapshots` quedaron igual;
   - después de derivar da 409, y con el tope lleno da 429;
   - **no se hizo** la prueba de pedidos en paralelo con el contador nuevo: la frenó el usuario, que la hace él.
8. **Permisos:** un seller y un viewer reciben 403 en los 17 endpoints. La importación de otra empresa da 404.
9. **Lint, typecheck y build:**
   - `npm run lint` y `npm run build` pasan;
   - `npm run typecheck` falla solo en `apps/api/test/inbox-reply.test.ts:317`, que es previo (commit 74ef629; ese archivo no cambió);
   - el bundle inicial quedó en 515,63 kB, con el aviso en 500 kB (ver la deuda);
   - el archivo de secretos de la raíz no se leyó ni se tocó.

También se recorrieron las pantallas en el navegador, en el celular y en modo oscuro, sin scroll horizontal: el playground de punta a punta, el resumen de cambios, Descartar, Productos, Historial y el probador del extractor.

### Tests existentes rotos (sin arreglar, a pedido)

- `apps/api/test/catalog-db.test.ts:392-397` espera `PERMISSION_DENIED` al borrar de `catalog_import_rows`. La 0027 ahora da ese DELETE (solo para vistas previas). Quedó anotado en la deuda.

### Revisores

- **revisor-seguridad: APROBADO**, sin críticos ni altos.
  - Se corrigió el MEDIO: el tope del playground se podía saltear con pedidos en paralelo. Ahora se suman los turnos en curso, dentro del lock.
  - Se corrigió un BAJO: el probador usaba los dominios del borrador. Ahora usa los guardados.
  - Quedan anotados el turno que falla antes del insert y los archivos locales sin trackear, que no van al commit.
- **revisor-codigo: APROBADO**, sin bloqueantes. Se corrigió:
  - faltaban decisiones en `docs/decisiones.md` y había referencias equivocadas;
  - el tope del playground y los dominios del probador (los mismos dos de arriba);
  - las vistas previas se acumulaban: ahora la purga las borra (0028) y hay un tope de 20 subidas por hora;
  - el `currentVersion` del 409;
  - la config inicial traía datos inventados;
  - el resumen de cambios mostraba claves técnicas;
  - el nombre del archivo ahora se guarda en UTF-8;
  - los mensajes de zod cambiaban antes de validar el entorno;
  - faltaba una nota en el `AiBudgetGuard`;
  - una carrera al abrir productos.

  El test roto queda anotado.

### Guía de prueba en el navegador (punto B)

Con `npm run dev:api` y `npm run dev:web` (http://localhost:4200).

- La empresa con el catálogo real es Cerámicos Demo (owner.ceramicos@example.test).
- Para importar sin tocar los 4.659 productos de Lecer, conviene Inmobiliaria Demo (owner.inmobiliaria@example.test), que ya tiene la sección de catálogo con lecer.com.ar.

1. **Importar el Excel de 5 productos:**
   - Catálogo → Importar → arrastrá el archivo.
   - Revisá el mapeo sugerido y los ejemplos, y tocá "Ver cambios".
   - Filtrá por nuevos y por inválidas.
   - Tocá "Aplicar" y confirmá.
   - Mirá Productos e Historial, y después "Volver a la anterior" con su confirmación.
2. **Extractor:**
   - Catálogo → Configuración → prendé una regla (por ejemplo, el precio de lista) y escribí el selector.
   - Pegá la URL de un producto y tocá "Probar": muestra cada campo y de dónde salió, sin guardar.
   - Tocá "Guardar".
3. **Tono, regla y pregunta frecuente:**
   - Configuración del agente → Personalidad y reglas: cambiá el tono y agregá una regla.
   - Conocimiento: agregá una pregunta frecuente.
   - Fijate que aparezca "N cambios sin guardar".
   - "Probar el agente": escribí como un cliente y abrí "Detalle" (puntaje, datos, disparadores y resumen).
   - Probá "Otro día y hora" (por ejemplo, domingo 22:00).
   - Tocá "Guardar".
4. **Umbral y vista de ejemplo:** en Puntaje, cambiá "Caliente desde", mové las señales de la vista de ejemplo y mirá cómo cambia el nivel.
5. **Comparar y restaurar:**
   - Historial → elegí las versiones A y B → "Comparar A con B".
   - Tocá "Restaurar" en una versión y confirmá: aparece como versión nueva.
6. **Celular y modo oscuro:** repetí lo anterior con el ancho del celular y el tema oscuro. Las pestañas se desplazan de costado, "Guardar" queda fijo abajo y el playground ocupa toda la pantalla.
7. **Concurrencia del tope (lo que quedó pendiente):** con 29 turnos en la última hora, mandá 3 turnos del playground a la vez. Tiene que pasar uno y los otros dos tienen que dar 429.

### Decisiones tomadas

- #113: importar dentro del request, rehacer sobre el mismo id, multer, archivo por 24 h y purga.
- #114: playground sin estado en el servidor y con tabla propia.
- #115: todo el catálogo con `catalog.update`.
- #116: confirmación de transparencia (reemplaza parte de #110).
- #117: límites en memoria y dominios guardados en el probador.
