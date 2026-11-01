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

## Resultado

_Hecha el 2026-11-01 en la rama `claude/responder-desde-panel`, que sale de `claude/bandeja-y-leads`
después del commit de la 014 (`e0ed17a`)._

### Decisiones (ver `docs/decisiones.md` #83 a #87)

- **Endpoint (#83):** `POST /api/conversations/:id/messages` con `conversation:reply` y `ConversationScope`.
  - La clave es `panel:<uuid>`: la misma clave devuelve el envío de la primera vez; con otro texto, 409 `IDEMPOTENCY_CONFLICT`.
  - Si una regla de envío no se cumple, 409 con un código y rollback: no queda ninguna fila.
  - Responde 200, no 201: `ApiRoute` documenta una sola respuesta.
- **IA (#84):**
  - se pausa al encolar, con la misma función que el eco humano;
  - las respuestas de la IA en cola pasan a `rejected`/`superseded` (migración 0018, la misma que la `0014` de la 010);
  - la conversación queda bloqueada con `FOR UPDATE`, como en la T2.
- **Estado de los mensajes (#85):**
  - la lista une `messages` con el outbox sin mensaje y trae `delivery: { state, reason }`, que reemplaza a `status`;
  - el detalle trae `reply: { allowed, reason, pausedUntil }`, calculado con la misma expresión que el envío;
  - un `maybe_sent` no ofrece reintentar.
- **"Sin responder" y derivadas sin atender (#86):** cuentan la respuesta del panel desde que se encola.
- **Proveedor falso (#87):**
  - `WHATSAPP_FAKE_PROVIDER` vale para los e2e y los tests de la API, y está prohibido en producción;
  - Playwright no reusa una API ya levantada.
- **Fuera de lo pedido:**
  - botón **Actualizar** en la conversación;
  - estilo `.input:disabled` en el sistema de diseño;
  - `interactive-widget=resizes-content` en el viewport.
- **Simplificación:** no hay una burbuja local antes de que responda el servidor. Mientras tanto, el botón dice "Enviando…" y el mensaje aparece "En cola" apenas llega la respuesta, en unos 100 ms.

### Cómo se emparejan los ecos

- Ya funcionaba con la 005. El worker guarda el mensaje y el `external_id` en el outbox en la misma transacción del `sent`.
- El eco de WAHA de ese id se descarta como propio. Si llega mientras está en `sending`, se reprograma y después se descarta.
- El remitente sigue siendo `user` con quién lo mandó, y la pausa no se mueve. Hay test en `echo-ack.test.ts`.

### Archivos

- **API:**
  - `src/inbox/reply.service.ts` (nuevo), `inbox.controller.ts`, `inbox.contracts.ts`, `inbox.service.ts` e `inbox.module.ts`;
  - `src/messaging/outbound/outbound.service.ts`: `SEND_REJECT_REASON`, `pauseAiAfterHuman`, `supersedeQueuedAiReplies` y el 409 con una clave ajena;
  - `src/whatsapp/inbound/inbound.service.ts`: usa la pausa compartida;
  - `src/whatsapp/providers/fake/fake.provider.ts` (nuevo), `whatsapp.module.ts` y `config/env.ts`;
  - `src/http/api-route.ts` y `scripts/openapi.ts` (409 documentado);
  - `src/db/schema/messaging.ts` y `drizzle/0018_outbound_superseded.sql`;
  - `scripts/seed.ts`: Carla Estados, Diego Ventana, Elena Respuesta y la sucursal con los envíos pausados;
  - tests: `inbox-reply.test.ts` (nuevo), `echo-ack`, `ai-reply`, `env`, `helpers` e `inbox-api` (las claves del mensaje).
- **Panel:**
  - `pages/inbox/reply-box.ts`, `delivery-status.ts` y `reply-box.spec.ts` (nuevos);
  - `conversation-page.ts`, `format.ts` y `format.spec.ts`;
  - `api/inbox-api.ts` y el cliente regenerado;
  - `styles.css` e `index.html`;
  - e2e: `reply.spec.ts` (nuevo), capturas 16 a 18 y `playwright.config.ts`.
- **Otros:** `.env.example` y `docs/decisiones.md`.

### Verificación

1. **Tests e2e de la API (`inbox-reply.test.ts`, 17):**
   - envío de owner, admin y seller, con `sender_type = 'user'` y `sent_by_user_id`;
   - 404 para otro número, otra empresa o una conversación inexistente, y 403 para el viewer;
   - validaciones;
   - idempotencia secuencial y en paralelo, otro texto, y una clave de un número que no se ve;
   - 409 por canal pausado o desconectado, sin entrantes y con la ventana vencida, con el detalle explicándolo;
   - pausa de 12 h que no acorta una más larga, y respuestas de la IA en cola canceladas;
   - estados, sin duplicados, cursor, y "sin responder" y derivada sin atender. ✔
2. **Eco:** el de una respuesta del panel no duplica, no cambia quién la mandó y no mueve la pausa. ✔
3. **`ai-reply`:** si el panel responde mientras la IA piensa, queda `skipped:ai_paused` y el entrante siguiente tampoco recibe respuesta. ✔
4. **Playwright (`reply.spec.ts`):**
   - el seller escribe, el mensaje aparece en cola y después como enviado, y la IA queda pausada;
   - número pausado y ventana vencida, con la caja deshabilitada y el motivo;
   - estados con ícono y texto, y "Reintentar" solo en lo que seguro no salió. ✔
   - En la base, el envío salió con el proveedor falso (`true_FAKE…`).
5. **Prueba real con WAHA:** **pendiente**, espera el OK del usuario.
6. **Capturas:** 14 en `apps/web/test-results/capturas/` (16 a 18), en claro y oscuro, a 375 y 1280 px. El usuario las aprobó ✔
7. **Calidad:**
   - API 653/653 y panel 83/83;
   - lint, typecheck y build OK, con un bundle inicial de 494,87 kB.
8. **`git status`:** sin `.env`.

### Revisores

- **`revisor-codigo`: APROBADO.**
  - IMPORTANTE, corregido: "Reintentar" se seguía ofreciendo después de reenviar, así que un segundo clic duplicaba el mensaje. Ahora se oculta después de un reintento y si hay un mensaje posterior del equipo con el mismo texto.
  - Menores, corregidos:
    - el error del reintento ahora avisa;
    - no se borra lo que se escribió mientras se enviaba;
    - un comentario del módulo.
  - Menor, anotado: la burbuja local es la simplificación de arriba.
- **`revisor-seguridad`: APROBADO**, con tres BAJO:
  - una clave usada en un número que no se ve daba 500: ahora da 409, con test;
  - el reintento creaba una clave por clic: ahora la clave se conserva hasta que el servidor confirma;
  - responder a un lead del seed con la API normal (WAHA real) puede salir a un número inventado: queda como seguimiento.
