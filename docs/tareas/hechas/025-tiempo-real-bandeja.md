# Tarea 025: bandeja y grilla de leads en tiempo real (SSE)

## Contexto

Es la tercera de las tres tareas de la bandeja (014 → 024 → **025**). Hoy la grilla y la conversación se
actualizan al navegar o con el botón de actualizar. Con esta tarea, cuando entra un mensaje, cambia un
puntaje, se deriva una conversación o llega un acuse, el panel se entera solo.

Spec: `docs/specs/bandeja-y-leads.md` (sección "Tiempo real"). Referencias: `CLAUDE.md` (pg-boss sobre
Postgres, sin Redis) y la regla de visibilidad por número de la 014.

## Objetivo

Un canal de eventos del servidor (SSE), autenticado con la cookie de sesión, que avisa de los cambios solo
a quien puede verlos (empresa activa y números asignados). El panel actualiza la grilla, la bandeja y la
conversación abierta sin recargar.

## Antes de empezar

1. La 014 y la 024 tienen que estar hechas y commiteadas.
2. Proponé cómo se publican los eventos. Por ejemplo, `LISTEN/NOTIFY` de Postgres desde los workers
   (entrante, `ai-reply`, outbound, acuses) hacia la instancia de la API que tiene la conexión SSE. Tené en
   cuenta:
   - varias instancias de la API;
   - el límite de tamaño de `NOTIFY`;
   - qué pasa con los eventos que se pierden mientras el navegador está desconectado.

   Justificalo y **no instales nada sin mi OK.**

3. Revisá cómo se comporta SSE a través del proxy de Angular en desarrollo y de Caddy en producción
   (buffering y timeouts).

## Pasos / requisitos

1. **`GET /api/events` (SSE).**
   - Pasa por `TenantGuard`, con sesión y empresa activa.
   - La lista de conversaciones visibles se calcula con la misma regla de la 014 y se vuelve a validar
     cuando cambia una asignación o la membresía (la baja de un seller corta sus eventos).
   - Los eventos llevan **solo identificadores y el tipo**, por ejemplo
     `{ type: 'message.created', conversationId }`. Nunca texto de mensajes, nombres ni teléfonos: el
     panel vuelve a pedir el detalle a los endpoints de la 014, que aplican la visibilidad.
   - Latido periódico para que los proxies no corten la conexión. Al cerrarse la sesión (logout, sesión
     revocada o membresía desactivada) se cierra el stream.
   - Límite de conexiones por usuario.
2. **Publicación:** los puntos donde cambia una conversación (worker de entrantes, `ai-reply`, outbound,
   acuses y reactivar la IA) publican el evento después del commit. Nunca antes: un evento no puede apuntar
   a datos que no existen.
3. **Panel:**
   - Un servicio de eventos con `EventSource` (la cookie viaja sola, mismo origen) que se reconecta
     sola. Al reconectarse vuelve a consultar lo visible, porque pudo perder eventos.
   - La grilla y la bandeja se actualizan sin saltar de lugar mientras el usuario lee: una conversación
     nueva se marca y no reordena de golpe la página en la que está el usuario.
   - La conversación abierta suma los mensajes nuevos y actualiza los estados de los envíos de la 024.
   - Un indicador discreto muestra si el tiempo real está conectado o reconectando.
   - Mientras la pestaña está oculta se cierra la conexión, y se vuelve a abrir al mostrarla.
4. **Documentación:** en `docs/entorno-dev.md`, la configuración de Caddy para SSE (sin buffering, timeouts)
   y del proxy de desarrollo.

## Criterios de aceptación

- [ ] Con el panel abierto, un mensaje entrante (webhook de prueba) aparece en la grilla y en la
      conversación sin recargar, en menos de 3 segundos.
- [ ] Un seller no recibe eventos de conversaciones de números que no tiene, y al quitarle el número deja
      de recibirlos.
- [ ] Ningún evento lleva texto de mensajes ni datos personales.
- [ ] Logout, sesión revocada o membresía desactivada cierran el stream.
- [ ] Cortar y restablecer la conexión no pierde cambios: al reconectar, el panel se pone al día.
- [ ] Funciona a través del proxy de desarrollo. La configuración de Caddy queda documentada.
- [ ] `npm run test`, `lint`, `typecheck`, `build` y `e2e:web` pasan.

## Verificación (obligatoria)

1. Tests e2e de la API, con un cliente SSE en el test:
   - el owner recibe el evento de un mensaje nuevo;
   - el seller del número también, y el de otro número no;
   - sin sesión da 401;
   - logout cierra el stream.
2. Test de que el evento se publica después del commit: si la transacción hace rollback, no hay evento.
3. Test de visibilidad dinámica: quitar la asignación mientras el stream está abierto corta los eventos de
   ese número.
4. Inspección de los eventos publicados en el test: solo tienen `type` e identificadores.
5. Playwright: con el panel abierto, se simula un webhook entrante y el mensaje aparece sin recargar; se
   corta la red y, al volver, el panel se pone al día.
6. Capturas del indicador de conexión y de una conversación nueva marcada en la grilla, en claro y oscuro,
   a 375 y 1280 px.
7. `git status`: sin `.env`.

## Fuera de alcance

- Notificaciones push o por email, y sonido.
- WebSockets o un broker externo (Redis, etc.).
- Presencia ("quién está mirando esta conversación") y "escribiendo…" del vendedor.

## Entregable

Resumen: mecanismo de publicación elegido y su porqué, cómo se filtran los eventos, configuración de los
proxies, resultado de la verificación con las capturas, veredicto de `revisor-codigo` y
`revisor-seguridad`, decisiones nuevas en `docs/decisiones.md` y mensaje de commit propuesto.

## Resultado

_Hecha el 2026-11-01 en la rama `claude/tiempo-real-bandeja`, que sale de `claude/responder-desde-panel` (con la
023, la 014 y la 024)._

### Decisiones (ver `docs/decisiones.md` #88 a #93)

- **Publicación (#88):** `pg_notify('inbox_events', …)` dentro de la transacción de cada cambio. Postgres lo entrega
  solo con el commit y lo descarta con un rollback.
  - Cada instancia escucha con una conexión dedicada (`RealtimeListener`, +1 conexión por instancia).
  - Si se cae, reconecta con espera creciente y, al volver, manda `resync` al panel y revalida todos los streams.
  - El aviso lleva solo tipo e ids (~200 bytes) y se valida con zod.
- **Endpoint (#89):** `GET /api/events` con `TenantGuard` + `@RequirePermission({ conversation: ['read'] })` y
  `@NoTransaction()` (decorador nuevo). Mientras está abierto no ocupa conexiones de la base.
- **Filtro y cierre (#90):**
  - en memoria, por empresa activa y scope (`ConversationScope`); `conversation.read` va solo a quien la leyó;
  - revalidación cada 15 s y al instante con los avisos `access` (asignaciones), `user` y `session` (hook `after`
    de Better Auth, solo si la acción salió bien; la sesión va por sha256 del token);
  - `event: end` con el motivo;
  - 5 streams por usuario y 1000 por instancia (429), con el lugar reservado antes del primer await;
  - latido cada 25 s y corte de clientes lentos.
- **Panel: reconexión (#91):**
  - propia, con espera creciente, y vuelve a consultar al reconectar (sin `Last-Event-ID`);
  - pasa al refresco de 30 s después de 3 fallas;
  - con la pestaña oculta más de 10 s cierra el stream; sin red espera a `online`.
- **Bundle (#92):** el tiempo real se carga con `import()` después del primer render. El bundle inicial queda en
  497,9 kB. `AuthService.leaving` evita carreras con el logout y el cambio de empresa.
- **Pantallas (#93):**
  - las filas se actualizan en su lugar;
  - una nueva entra arriba con "Nueva" solo si el usuario está arriba (y en Leads, en la página 1); si no,
    aparece la pastilla "↑ N nuevas";
  - en la conversación, "↓ N mensajes nuevos";
  - el botón Actualizar de la conversación se reemplazó por "Reintentar" del indicador.

### Archivos

- **API:**
  - `src/realtime/` (nuevo): `publish.ts`, `realtime-listener.ts`, `realtime-hub.ts`, `events.controller.ts`,
    `events.contracts.ts` y `realtime.module.ts`;
  - `auth/decorators.ts` (`@NoTransaction`), `auth/tenant-transaction.interceptor.ts`, `auth/tenant.guard.ts`
    (`loadMembership`) y `auth/auth.ts` (hook `after`);
  - publicación en `whatsapp/inbound/inbound.service.ts`, `messaging/outbound/outbound.service.ts` y
    `outbound.worker.ts`, `inbox/inbox.service.ts`, `reply.service.ts`, `channels.service.ts` y
    `ai/reply/ai-reply.service.ts` (solo el aviso, en `apply` y `handOff`: no toca reglas ni prompts);
  - `config/env.ts`, `app.module.ts`, `scripts/openapi.ts` y `openapi.json`;
  - tests: `test/realtime.test.ts` (nuevo) y `test/sse-helpers.ts` (nuevo).
- **Panel:**
  - `core/realtime.ts`, `core/live-merge.ts` y sus specs (nuevos);
  - `ui/live-indicator.ts` y `pages/layout/realtime-boot.ts` (nuevos);
  - `core/poll.ts` (`pollWhileNoRealtime`), `core/auth/auth.service.ts` (`leaving`) y `core/inbox-summary.ts`;
  - `pages/layout/shell.ts`, `pages/leads/leads-page.ts`, `pages/inbox/inbox-page.ts`,
    `pages/inbox/conversation-page.ts` y `styles.css`;
  - cliente regenerado (`ConversationEvent`, `ChannelEvent`, `StreamEnd`);
  - e2e: `realtime.spec.ts` (nuevo), `helpers.ts` (`inbound`), `capturas.spec.ts` (19 a 22), `reply.spec.ts` y
    `auth.spec.ts` (locator del menú);
  - `playwright.config.ts`: clave HMAC al azar por corrida y `AI_ENABLED=false`.
- **Otros:** `.env.example` (variables `REALTIME_*`), `docs/entorno-dev.md` (Caddy y proxy de desarrollo) y
  `docs/decisiones.md`.

### Verificación

1. **Tests de la API (`realtime.test.ts`, 20):**
   - 401 y 403;
   - entrante por el webhook en menos de 3 s, al owner y al seller del número, y no al de otro número ni a otra
     empresa;
   - `conversation.read` solo a quien la leyó;
   - visibilidad dinámica sin reconectar;
   - logout, revocar sesiones, membresía desactivada y cambio de empresa cierran el stream;
   - puntos de publicación: respuesta del panel, worker de envío, acuse, estado del canal y falla del canal. ✔
2. **Después del commit:** con un rollback no hay evento, y un 409 de la respuesta del panel no avisa nada. ✔
3. **Contenido:** cada NOTIFY y cada `data:` tienen solo claves permitidas con UUID, sin el nombre, el texto ni
   el teléfono. ✔
4. **Límites:** 429 en serie y en paralelo, un pedido cortado antes de abrir no queda contado, latido, reconexión
   del listener con `resync`, y una acción de Better Auth fallida no avisa. ✔
5. **Playwright (`realtime.spec.ts`):**
   - fila de Leads actualizada en su lugar sin reordenar;
   - conversación nueva arriba con "Nueva";
   - mensaje en la conversación abierta en menos de 3 s;
   - red cortada (`setOffline`): el indicador dice "Sin conexión" y al volver se pone al día. ✔
   - Todo a través del proxy de Angular.
6. **Capturas:** 28 nuevas (19 a 22, en claro y oscuro, a 375 y 1280 px) en `apps/web/test-results/capturas/`. El usuario las aprobó ✔
7. **Calidad:**
   - API 673/673 y panel 96/96;
   - e2e 103/103 desde un seed limpio;
   - lint, typecheck y build OK (497,94 kB).
8. **`git status`:** sin el archivo de secretos.

### Revisores

- **`revisor-seguridad`: APROBADO** (sin CRÍTICO ni ALTO). Lo que marcó, todo corregido:
  - MEDIO: el hook `after` de Better Auth corre también si el endpoint falla, así que un anónimo podía forzar
    revalidaciones masivas. Ahora solo avisa si la acción salió bien. Tiene test.
  - MEDIO: el límite de streams se salteaba con pedidos en paralelo. Ahora el lugar se reserva antes del primer
    await, y la vuelta periódica revalida con una concurrencia de 4. Tiene test.
  - BAJO: un aviso que llegaba mientras un stream se abría se perdía. Ahora un contador lo detecta y revalida.
  - BAJO: faltaban `/change-password`, `/delete-user` y `/organization/delete` en el hook.
- **`revisor-codigo`: APROBADO** en la segunda ronda. En la primera pidió cambios:
  - IMPORTANTE: el mismo límite en paralelo.
  - IMPORTANTE: faltaban tests de los puntos de publicación. Se sumó la sección 4b.
  - Menores, corregidos:
    - test de `tenant_changed`;
    - revalidar después de un `resync`;
    - cancelar el refresco anterior en `liveList`;
    - `conversation.updated` en `handOff`;
    - las decisiones.
  - Menores que quedan anotados:
    - `ai-reply.apply` sin test con SSE (una línea; necesita el LLM simulado);
    - las rutas admin y de organización del hook, sin test (las cubre la vuelta de 15 s);
    - el bundle inicial queda a 2 kB del presupuesto.

### Hallazgos en el camino

- **Bug propio corregido:** un `close` antes de registrar el stream lo dejaba contado y, al quinto, el usuario
  recibía 429. Tiene test.
- **Los e2e ensucian la base de desarrollo:** cada corrida suma conversaciones "Prueba …" en Cerámicos Demo y el
  seed no las borra. Con más de 50, la bandeja muestra "Ver todas en Leads" (por eso se acotó el locator de
  `auth.spec`).
- **Bandeja por prioridad:** una conversación recién llegada puede quedar fuera de las primeras 50 (las que esperan
  más van arriba).
