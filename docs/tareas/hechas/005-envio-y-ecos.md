# Tarea 005: envío de mensajes, ecos y pausa de la IA

## Contexto

Con la tarea 004 los mensajes entrantes del número de prueba ya se guardan en `messages`. Esta tarea agrega
la otra mitad: **mandar** mensajes de forma segura para una conexión no oficial, y **detectar cuándo una
persona responde desde el celular** para que la IA no se meta en esa conversación.

La tarea 006 (primera respuesta de la IA) va a usar el servicio de envío que sale de acá. Por eso la
interfaz tiene que quedar firme.

Referencias: `CLAUDE.md` (reglas de conexión no oficial y de IA), `.claude/rules/whatsapp.md`, skill
`webhook-whatsapp`, decisiones de la 003 y la 004 en `docs/decisiones.md`.

## Objetivo

- Interfaz `WhatsAppProvider` con envío, visto y "escribiendo…", e implementación para WAHA.
- Envío por cola con _outbox_, sin dobles envíos y con reglas anti-bloqueo para canales no oficiales.
- Ecos (`fromMe`): distinguir lo que mandó el sistema de lo que mandó una persona desde el teléfono. Si fue
  una persona, pausar la IA en esa conversación.
- Acuses (`message.ack`): actualizar `messages.status` (enviado, entregado, leído).

## Antes de empezar

1. Leé `CLAUDE.md`, el skill `ejecutar-tarea`, `.claude/rules/whatsapp.md` y el código de
   `providers/waha/` y del worker de la 004.
2. **Consultá la documentación actual de WAHA** (NOWEB): enviar texto, marcar como visto, empezar y dejar
   de escribir, formato de la respuesta de envío (id del mensaje), eventos `message.any` y `message.ack`
   (valores del ack), y los códigos de error que indican riesgo de bloqueo o sesión caída. No inventes
   endpoints ni campos: si algo no coincide con la tarea, avisame antes de seguir.

## Pasos / requisitos

### 1. Interfaz del proveedor

En `libs/shared`, o donde ya estén los eventos normalizados:

- `WhatsAppProvider` con `capabilities` (`templates`, `within24hWindowOnly`, `adAttribution`,
  `outboundCampaigns`) y los métodos `sendText`, `markSeen`, `startTyping` y `stopTyping`.
- Resultado de `sendText`: `{ externalId, sentAt }` o un error tipado (`transient`, `rate_limited`,
  `session_down`, `blocked_risk`, `invalid_recipient`).
- `WahaProvider` en `providers/waha/` implementa la interfaz y traduce los errores de WAHA a esos tipos.
  Nada de WAHA fuera de esa carpeta.

### 2. Outbox (tabla nueva `outbound_messages`)

Sigue las convenciones de la 003: `tenant_id`, RLS forzada, FKs compuestas, grants mínimos y sin `DELETE`.

| Columna                    | Tipo        | Notas                                                     |
| -------------------------- | ----------- | --------------------------------------------------------- |
| `conversation_id`          | uuid        | FK compuesta                                              |
| `channel_id`               | uuid        | FK compuesta                                              |
| `idempotency_key`          | text        | NOT NULL, UNIQUE `(tenant_id, idempotency_key)`           |
| `sender_type`              | text        | CHECK (`ai`, `user`, `app`)                               |
| `sent_by_user_id`          | uuid        | NULL                                                      |
| `body`                     | text        | NOT NULL                                                  |
| `status`                   | text        | CHECK (`queued`, `sending`, `sent`, `failed`, `rejected`) |
| `attempts`                 | int         | NOT NULL default 0                                        |
| `last_error`               | text        | código de error, **sin** datos personales                 |
| `external_id`              | text        | NULL hasta que se envía                                   |
| `message_id`               | uuid        | NULL, FK compuesta a `messages` cuando se envió           |
| `created_at`, `updated_at` | timestamptz |                                                           |

Si te parece mejor otro diseño (por ejemplo, agregar estados a `messages`), proponémelo en el plan con el porqué.

### 3. Servicio de envío

`OutboundService.enqueueText({ conversationId, body, senderType, sentByUserId?, idempotencyKey })`:

- Corre dentro de la transacción de empresa del que llama (request o worker).
- **Reglas antes de encolar**, si se rompe alguna → `rejected` con motivo:
  - Canal no oficial: **nunca se inicia una conversación**. Tiene que haber un mensaje entrante del
    contacto en esa conversación, y el último entrante tiene que tener menos de 24 h (constante
    documentada; después va a la configuración de la empresa).
  - Contacto con `blocked = true` → rechazado.
  - Canal sin estado `connected` o con el envío pausado → rechazado.
- Inserta en `outbound_messages` (`queued`) y encola el trabajo en pg-boss. Repetir la misma
  `idempotency_key` no crea otro envío.

### 4. Worker de envío (conexión no oficial)

Secuencia para parecerse a una persona:

1. `markSeen` del chat.
2. `startTyping`.
3. Demora aleatoria proporcional al largo del texto, con mínimo y máximo (por ejemplo, entre 2 y 8 s;
   constantes documentadas). No bloquees el worker con esperas largas: usá la programación de pg-boss
   (`startAfter`) o una espera corta y acotada, y justificá la elección.
4. `stopTyping` y `sendText`.
5. Si sale bien: `outbound_messages` pasa a `sent` con `external_id`, se inserta en `messages`
   (`direction = outbound`, `sender_type` del outbox, `status = 'sent'`, `ON CONFLICT DO NOTHING`) y se
   enlaza con `message_id`. Todo en una transacción.

Límites por canal: un máximo de envíos por minuto (constante documentada) y **nunca dos envíos en paralelo
al mismo chat**. Usá `singletonKey` o un equivalente de pg-boss, o un lock en la base.

Errores:

- `transient` / `rate_limited` → reintento con backoff.
- `blocked_risk` → **pausa el envío del canal** (columna nueva `channels.sending_paused_until` + motivo),
  `outbound_messages` queda en `failed` y **no** se reinicia la sesión automáticamente.
- `session_down` → `channels.status = 'disconnected'` y `failed`.
- `invalid_recipient` → `failed` sin reintento.
- Antes de llamar al proveedor, el worker vuelve a chequear las reglas del paso 3: pueden haber cambiado
  mientras el trabajo esperaba en la cola.

### 5. Ecos (`message.any` con `fromMe`)

- Agregá `message.any` y `message.ack` a los eventos de la sesión en el script `dev:create-channel`, y
  documentá cómo actualizar la sesión que ya existe sin volver a escanear el QR.
- Al llegar un eco:
  - Si su `external_id` ya está en `messages` u `outbound_messages` → es nuestro, se ignora (idempotente).
  - Si hay un `outbound_messages` en `sending` para ese chat → **todavía no sabemos si es nuestro**: el
    trabajo se reprograma unos segundos después, con un límite de intentos.
  - Si no → lo escribió una persona desde el teléfono o desde WhatsApp Web: se inserta en `messages` con
    `direction = outbound`, `sender_type = 'user'`, `sent_by_user_id = NULL`, y se setea
    `conversations.ai_paused_until = now() + pausa` (constante documentada; por ejemplo 12 h).
- Un eco de un chat sin conversación (la persona le escribió primero a alguien desde el teléfono) → se
  crea contacto y conversación igual que en la 004, con la IA pausada.
- Si hace falta, agregá a `messages.status` el valor que corresponda (por ejemplo `pending`) con una
  migración, y justificalo.

### 6. Acuses (`message.ack`)

- Mapeo documentado de los valores de WAHA a `sent`, `delivered`, `read` y `failed`.
- Solo `UPDATE` de `status`, que es el permiso que ya tiene `ventas_app`. **Nunca retrocede**: si ya está
  en `read`, un `delivered` tardío no lo cambia.
- Ack de un mensaje que no existe todavía → se ignora (no se reintenta).

### 7. Script de desarrollo

`npm run dev:send -- --conversation <id> --text "..."`: encola un envío con `sender_type = 'app'` usando el
servicio real, con sus reglas. Solo fuera de `production`.

### 8. Logs

Sin texto, teléfonos ni nombres. Sí: ids, tipo de evento, resultado y código de error.

## Criterios de aceptación

- [ ] Un mismo envío nunca sale dos veces (idempotencia por clave y por `external_id`).
- [ ] Un canal no oficial no puede iniciar conversaciones ni escribir pasadas las 24 h del último entrante.
- [ ] Un mensaje escrito desde el teléfono pausa la IA en esa conversación; uno mandado por el sistema, no.
- [ ] `blocked_risk` pausa el canal sin reiniciar la sesión.
- [ ] Nada de WAHA fuera de `providers/waha/`.
- [ ] `npm run test`, `npm run lint` y `npm run typecheck` pasan.

## Verificación (obligatoria)

Tests con un proveedor falso, salvo el punto 12:

1. `enqueueText` dos veces con la misma clave → 1 fila en el outbox y 1 envío al proveedor.
2. Conversación sin entrantes → `rejected`; último entrante de hace más de 24 h → `rejected`; contacto
   bloqueado → `rejected`; canal pausado o desconectado → `rejected`.
3. Envío correcto → orden de llamadas visto → escribiendo → dejar de escribir → enviar; fila en `messages`
   con `sender_type` correcto y outbox `sent` enlazado.
4. Dos envíos al mismo chat encolados juntos → nunca se ejecutan en paralelo.
5. Errores: `transient` → reintenta; `blocked_risk` → canal pausado, sin reintentos y sin llamar a reiniciar
   la sesión; `session_down` → canal `disconnected`; `invalid_recipient` → `failed` sin reintento.
6. Eco de un mensaje propio, antes y después de que vuelva la respuesta de `sendText` → no se duplica y no
   pausa la IA.
7. Eco de un mensaje escrito desde el teléfono → `sender_type = 'user'` y `ai_paused_until` en el futuro.
8. Acuses: `sent` → `delivered` → `read` actualizan; `delivered` después de `read` no lo cambia; ack de
   mensaje inexistente → ignorado.
9. Aislamiento: un envío o eco del canal de la empresa A nunca toca filas de la B.
10. `outbound_messages`: RLS forzada, sin `DELETE` para `ventas_app`, sin acceso para `ventas_auth`.
11. Logs de los tests 3 y 7: sin texto ni teléfonos.
12. **Prueba real (la hago yo con vos):**
    - desde mi celular le escribo al número de prueba;
    - con `dev:send` respondés en esa conversación → me llega con visto y "escribiendo…" antes;
    - lo veo y aparece `read` en `messages.status`;
    - desde el teléfono de prueba respondo a mano → aparece como `user` y la conversación queda con la IA pausada;
    - `dev:send` a un contacto que nunca escribió → rechazado.
13. `git status`: sin `.env`.

## Fuera de alcance

- La IA, el clasificador y cualquier respuesta automática: tarea 006.
- Envío de multimedia, plantillas y campañas.
- Endpoints o pantallas para responder desde el panel: tarea 011.
- Reanudar la IA a mano o configurar la pausa por empresa: tarea 009.
- Cloud API de Meta (la interfaz ya lo contempla con `capabilities`).

## Entregable

Resumen: archivos creados, diseño final del outbox, constantes elegidas (demoras, límites, pausa, ventana),
mapeo de errores y de acks de WAHA, resultado de cada punto de la verificación, veredicto de
`revisor-codigo` y `revisor-seguridad`, decisiones nuevas en `docs/decisiones.md` y mensaje de commit propuesto.

## Resultado

**Estado:** hecha (2026-10-24). Aprobada por `revisor-seguridad` (ronda 1) y `revisor-codigo` (ronda 2).

### Archivos

- Nuevos:
  - `apps/api/src/messaging/outbound/` (`outbound.constants.ts`, `outbound.service.ts`, `outbound.worker.ts`, `outbound.module.ts`)
  - `apps/api/src/whatsapp/providers/waha/waha-send.ts`
  - `apps/api/drizzle/0006_outbound_messages.sql` (generada; el UNIQUE de `messages` se movió antes de la FK que lo usa) y `0007_outbound_permissions_rls.sql`
  - `apps/api/scripts/send-dev-message.ts` (`dev:send`) y `resume-dev-channel.ts` (`dev:resume-channel`)
  - Tests: `outbound.test.ts`, `echo-ack.test.ts`, `waha-send.test.ts`, `outbound-helpers.ts`; fixtures `message-any-from-me-lid.json` y `message-ack-read.json`
- Modificados:
  - `libs/shared/src/whatsapp/events.ts` (`message.echo`, `message.status`)
  - `apps/api/src/whatsapp/provider.ts` (envío, visto, escribiendo, errores tipados)
  - `providers/waha/` (`waha-client.ts`, `waha-normalize.ts`, `waha.provider.ts`)
  - `inbound/` (ecos, acuses, reprogramación de ecos)
  - `db/schema/messaging.ts`, `jobs/jobs.module.ts`, `app.module.ts`
  - `scripts/lib/waha-session.ts` (eventos `message.any`, `message.ack` y `session.status`)
  - Los `package.json`, `docs/decisiones.md` (#28–#35 y deuda de la 005), `docs/entorno-dev.md` y el skill `webhook-whatsapp`

### Diseño final

- **Outbox:** tabla `outbound_messages` aparte de `messages`, con RLS forzada, sin `DELETE` y `UPDATE` solo de las columnas de estado.
- **Cola:** `whatsapp-outbound` con policy `singleton` por conversación. El trabajo se encola en la misma transacción que la fila (`fromDrizzle` de pg-boss).
- **Contra el doble envío:** claim atómico `queued → sending` bajo un lock por canal. Una fila en `sending` nunca se reenvía.
- **Ecos:** un id conocido es nuestro. Con un envío en curso en el canal, el eco se reprograma. Si coincide con un envío `unknown_outcome`, se reconcilia y la IA se pausa igual. Si no, es de una persona (`user`) y la IA se pausa 12 h.

### Constantes

| Qué                                      | Valor                                             |
| ---------------------------------------- | ------------------------------------------------- |
| Ventana desde el último entrante         | 24 h                                              |
| Pausa de la IA                           | 12 h                                              |
| "Escribiendo…"                           | 1,5 s + 60 ms por carácter, ±25 %, entre 2 y 8 s  |
| Envíos por canal                         | 6 por minuto                                      |
| Separación entre salientes al mismo chat | 30–60 s                                           |
| Timeouts                                 | 5 s visto/escribiendo, 15 s envío                 |
| Envío trabado                            | a los 2 min                                       |
| Reintentos de un eco                     | 6, cada 5 s                                       |
| Cola                                     | `expireInSeconds` 60; peor caso de un envío ~38 s |

### Mapeos de WAHA

- **Errores:**

  | Respuesta                                            | Tipo                                                                   |
  | ---------------------------------------------------- | ---------------------------------------------------------------------- |
  | No se pudo conectar                                  | `transient`                                                            |
  | 429                                                  | `rate_limited`                                                         |
  | 400                                                  | `invalid_recipient`                                                    |
  | 404 / 422                                            | `session_down`                                                         |
  | "server returned error 463/475"                      | `blocked_risk` (pausa el canal sin vencimiento, no reinicia la sesión) |
  | Cualquier otra respuesta, timeout o respuesta sin id | `unknown_outcome` (sin reintento)                                      |

- **Acuses:** `-1 → failed`, `1 → sent`, `2 → delivered`, `3/4 → read`, `0` se ignora. Nunca retroceden. Los acuses de entrantes se ignoran.
- **Ids:** canónico `<true|false>_<key.id>`.

### Verificación

| Punto | Resultado                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–11  | `npm run test`: 207/207, en `outbound.test.ts`, `echo-ack.test.ts` y `waha-send.test.ts`, más los anteriores ajustados. `npm run lint`, `npm run typecheck` y Prettier OK. |
| 12    | Prueba real con el usuario: ver detalle abajo.                                                                                                                             |
| 13    | `git status` sin archivos de secretos.                                                                                                                                     |

Detalle de la prueba real (punto 12):

- Entrante por `message.any`, guardado con el id nuevo.
- `dev:send`: visto, "escribiendo…" y envío, los tres con 201 de WAHA.
- `messages.status` llegó a `read`.
- Los ecos propios no se duplicaron ni pausaron la IA.
- Un mensaje escrito a mano desde el teléfono de prueba quedó como `user`, con la conversación creada y la IA pausada 12 h.
- Dos envíos seguidos al mismo chat salieron con 49 s de separación.
- No se probó en real `dev:send` a un contacto sin entrantes; lo cubre el test automático 2.

### Lo que salió en la prueba real

`sendSeen` con solo el `chatId` dio 400: NOWEB sin store no sabe qué mensajes tiene un chat. Se corrigió pasando los ids originales de los entrantes sin leer, tomados de `raw` (decisión #35). Es posterior a las revisiones: la cubren los tests nuevos y la prueba real.

### Revisores

- **`revisor-seguridad`:** aprobado, sin CRÍTICO, ALTO ni MEDIO. Se corrigieron dos de sus BAJO:
  - el regex de 463/475;
  - la pausa de la IA al reconciliar por texto.

  Los otros dos quedaron como deuda: levantar la pausa por rol en el endpoint de la 011 y el id canónico sin chat.

- **`revisor-codigo`:** aprobado en la ronda 2. En la ronda 1 marcó dos IMPORTANTES, ya corregidos:
  - los 4xx/3xx raros ahora son `unknown_outcome`;
  - el chat del eco sale de `_data.key.remoteJid`, el enlace al mensaje se hace solo dentro de la misma conversación y el envío en curso se busca a nivel de canal.

### Decisiones

- #28 a #35 en `docs/decisiones.md`.
- Las decisiones que no estaban en la tarea:
  - el id canónico;
  - la suscripción a `message.any` sin `message`;
  - `unknown_outcome` como sexto tipo de error;
  - `claimed_at` y `reject_reason` en el outbox;
  - `--tenant` en `dev:send`;
  - la separación de 30–60 s entre salientes al mismo chat;
  - la pausa sin vencimiento ante riesgo de bloqueo;
  - el visto por ids originales.
