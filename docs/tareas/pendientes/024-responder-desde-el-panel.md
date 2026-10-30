# Tarea 024: responder por WhatsApp desde el panel

## Contexto

Es la segunda de las tres tareas de la bandeja (014 → **024** → 025). Con la 014, el vendedor ve sus
conversaciones. Con esta, también contesta desde el panel, en lugar de desde el teléfono. El envío ya
existe para la IA: el outbox `outbound_messages`, el worker que hace visto → escribiendo → enviar, los acuses
y la pausa del canal por riesgo de bloqueo (tarea 005).

Spec: `docs/specs/bandeja-y-leads.md` (sección "Responder desde el panel"). Referencias: `CLAUDE.md` (regla
de la conexión no oficial), skill `webhook-whatsapp`, `apps/api/src/messaging/outbound/outbound.service.ts`
(`enqueueText`, idempotencia y `senderType: 'user'`) y la deuda de la 005 en `docs/decisiones.md`, en
particular "Envío desde el panel" y "Levantar la pausa por riesgo de bloqueo".

## Objetivo

Desde la conversación, el owner, el admin y el seller del número pueden escribir y enviar un mensaje de
texto, siempre que sea una conversación que inició el cliente. Ven el estado del mensaje y la IA se pausa
igual que cuando responde una persona desde el teléfono.

## Antes de empezar

1. La 014 tiene que estar hecha y commiteada: este endpoint usa su misma regla de visibilidad por número.
2. Leé cómo se procesan hoy los ecos (`message.any`) y cómo se emparejan con el outbox, para que un mensaje
   enviado desde el panel no se duplique ni se tome como un eco humano nuevo.
3. Revisá la deuda de la 005 sobre la "parte siguiente" de una respuesta de la IA cuando hay un envío
   humano en cola.

## Pasos / requisitos

1. **`POST /api/conversations/:id/messages`.**
   - Body: `{ body, idempotencyKey }`. El body es texto no vacío con un largo máximo; se recorta y se valida
     con DTO.
   - Lo pueden usar owner, admin y el seller del número. Una conversación de otro número da 404 y un viewer
     recibe 403.
   - Solo se puede enviar en una conversación que ya existe y que tiene al menos un mensaje entrante (no se
     inician conversaciones).
   - Encola con `OutboundService.enqueueText` (`senderType: 'user'`, `sentByUserId` = el usuario del
     panel). Repetir la misma `idempotencyKey` no envía dos veces.
   - En la misma transacción, pausa la IA (`ai_paused_until` = ahora + `AI_PAUSE_AFTER_HUMAN_HOURS`) y
     cancela o deja sin efecto las respuestas de la IA pendientes de esa conversación.
   - Con el canal pausado (`sending_paused_until` vigente) o desconectado, responde 409 con un código que
     el panel pueda explicar, y no encola nada.
2. **Estado del mensaje:**
   - El endpoint de mensajes de la 014 devuelve también los envíos en cola (`queued`/`sending`) y el estado
     de cada mensaje: enviado, entregado, leído, fallido o rechazado.
   - El texto de un error del proveedor nunca llega al panel: solo un código.
3. **Panel:**
   - Caja de texto al pie de la conversación, con varias líneas y enviar con Ctrl/Cmd+Enter. En el celular
     queda fija abajo y respeta el teclado.
   - El mensaje aparece al instante como "en cola" y se actualiza al recargar o con el botón de actualizar
     (el tiempo real llega con la 025).
   - Muestra el estado de cada mensaje propio con ícono y texto (no solo con color), y un reintento cuando
     falló.
   - Con el canal pausado: caja deshabilitada y un aviso que explica por qué.
   - Hay que avisar que el mensaje sale por WhatsApp desde el número de la empresa.

## Criterios de aceptación

- [ ] Owner, admin y el seller del número envían un texto y el mensaje llega al cliente por WAHA.
- [ ] Un seller de otro número recibe 404 y un viewer, 403.
- [ ] La misma `idempotencyKey` dos veces genera un solo envío.
- [ ] Después de enviar desde el panel, la IA no responde al siguiente mensaje del cliente durante la pausa
      configurada.
- [ ] Con el canal pausado no se encola nada y el panel lo explica.
- [ ] No se puede enviar en una conversación sin mensajes entrantes.
- [ ] El estado del mensaje (en cola, enviado, entregado, leído, fallido) se ve en el panel.
- [ ] `npm run test`, `lint`, `typecheck`, `build` y `e2e:web` pasan.

## Verificación (obligatoria)

1. Tests e2e de la API:
   - envío correcto, que deja una fila en `outbound_messages` con `sender_type = 'user'` y
     `sent_by_user_id`;
   - idempotencia;
   - 404 para otro número y 403 para el viewer;
   - 409 con el canal pausado;
   - rechazo de una conversación sin entrantes;
   - pausa de la IA.
2. Test del worker y del eco: el eco de WAHA de un mensaje enviado desde el panel no crea un mensaje
   duplicado ni cambia quién lo envió.
3. Test de `ai-reply`: con una respuesta de la IA en espera, enviar desde el panel hace que la IA no
   conteste.
4. Playwright (con un proveedor simulado o WAHA de prueba): el seller escribe, el mensaje aparece en cola y
   después como enviado.
5. Prueba real con WAHA y el número de prueba: respuesta desde el panel, recibida en el teléfono del
   cliente de prueba.
6. Capturas de la caja de texto, los estados y el canal pausado, en claro y oscuro, a 375 y 1280 px.
7. `git status`: sin `.env`.

## Fuera de alcance

- Iniciar conversaciones, campañas o plantillas (no se hace con la conexión no oficial).
- Enviar imágenes, audios o archivos.
- Respuestas rápidas o sugerencias de la IA para el vendedor.
- Levantar la pausa del canal por riesgo de bloqueo (va con la pantalla de Canales, tarea 011).
- Tiempo real (tarea 025).

## Entregable

Resumen: endpoint, cómo se emparejan los ecos, cómo se pausa la IA, resultado de la verificación con las
capturas, veredicto de `revisor-codigo` y `revisor-seguridad`, decisiones nuevas en `docs/decisiones.md` y
mensaje de commit propuesto.
