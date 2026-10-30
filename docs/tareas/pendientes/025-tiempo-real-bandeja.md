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
