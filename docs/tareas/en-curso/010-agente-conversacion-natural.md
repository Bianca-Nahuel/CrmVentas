# Tarea 010: agente más conversacional (prompt v3 y respuestas en varios mensajes)

## Contexto

En las pruebas reales con la config de cerámicos (2026-10-27), el agente se sentía como un formulario:

- deriva muy rápido;
- mete muchas preguntas por mensaje y no elige cuáles son pertinentes: pasa a preguntas generales
  (retiro o envío, si necesita algo más) antes de responder las dudas del cliente;
- los mensajes son largos;
- saluda y pregunta en el mismo mensaje.

Una parte se corrige solo con la config (`max_questions_per_message: 1`, `availability` y `cannot_answer`
como `after_fields`, sin `custom_recomendacion`, estilo en `custom_instructions`). Esta tarea cubre lo que
pide código:

- la capa fija v2 empuja a preguntar los datos de la lista `faltan` "por orden de prioridad" en cada turno;
- la descripción de `availability` ("si tienen algo") y el "si dudás, marcalo" hacen que "¿tienen
  porcelanato símil madera?" derive al instante, aunque es una consulta de catálogo;
- `askFieldsText` repite el `intro` del disparador en cada pregunta;
- la salida tiene un solo `reply`, y dos salientes seguidos al mismo chat esperan entre 30 y 60 s
  (`SAME_CHAT_GAP_MS`).

**No cambia:** la regla IDENTIDAD ni el control `denies_assistant`. El agente puede sonar como un vendedor,
pero si le preguntan si es una persona, sigue diciendo que es un asistente automático.

## Objetivo

- Un prompt v3 que conversa como una persona por WhatsApp: responde primero, hace una pregunta a la vez y
  solo si es pertinente, y saluda sin interrogar.
- La salida admite de 1 a 3 mensajes cortos, que se envían como mensajes separados con su propio
  "escribiendo…".
- Menos derivaciones prematuras por consultas de catálogo, sin relajar ninguna de las reglas de producto.

## Antes de empezar

1. Leé `CLAUDE.md`, los skills `ejecutar-tarea`, `cambio-prompt-ia` y `webhook-whatsapp`, y
   `.claude/rules/ia.md` y `.claude/rules/whatsapp.md`.
2. Leé `apps/api/src/ai/prompts/v2/`, `reply/decide.ts`, `reply/output-checks.ts`, `reply/reply-engine.ts`,
   `reply/ai-reply.service.ts` (`sendAiReply`) y `messaging/outbound/` (`outbound.constants.ts`, el worker
   y la decisión #33 de `docs/decisiones.md`).
3. Corré los evals con v2 y guardá la línea base (catálogo y regresión de la 006).

## Pasos / requisitos

1. **Prompt v3** (`apps/api/src/ai/prompts/v3/`, sin editar v2) y `reply-engine.ts` apuntando a v3:
   - Saludo: si el cliente solo saluda, el mensaje es solo un saludo; si saluda y pregunta, saludo y
     respuesta. Nunca saludo y pregunta de calificación en el mismo turno.
   - Si el cliente hizo una pregunta, ese turno la responde; solo agrega una pregunta si hace falta para
     ayudarlo (medida, ambiente, para buscar el producto).
   - Como mucho una pregunta por turno, aunque la config permita dos (cuentan las de descubrimiento y las
     sugerencias). `faltan` deja de ser un orden fijo: el modelo elige el dato más pertinente para lo que se
     está hablando, y la logística (retiro o envío, zona, fecha) y el nombre van después de saber qué busca.
   - No repetir una pregunta que el cliente no contestó en el turno anterior.
   - **Nunca repreguntar un dato que ya está**, aunque lo haya dicho en este mismo mensaje o de otra forma
     ("un baño de 2x3", "para fin de mes"). Hoy `faltan` se calcula con el estado anterior al turno y
     contradice esa regla. En v3:
     - la salida suma `asks_field: key | null` (qué dato pregunta la respuesta);
     - `decide()` rechaza una respuesta que pregunta un campo que ya está en lo combinado del turno y, en su
       lugar, manda la respuesta sin la pregunta o pide otra vuelta;
     - se registran por conversación los campos que el cliente no quiso dar o que ya se preguntaron dos
       veces, y no vuelven a `faltan`.
   - No usar cierres genéricos ("¿algo más?"), frases de manual ni el nombre del cliente en cada mensaje.
   - Pedidos ajenos al negocio: una respuesta corta y simpática (no "con eso no puedo ayudarte") y volver
     al tema que venían hablando.
   - `availability`: separar "¿venden o trabajan X?" (consulta de catálogo: se responde con
     `buscar_productos`, sin afirmar stock) de "¿hay stock de este producto, para cuándo, lo puedo retirar
     hoy?" (disparador). Mantener la regla de marcarlo ante la duda solo para el segundo caso. Lo mismo en
     `TRIGGER_DESCRIPTIONS` de la capa de la empresa. El detector en código (`critical-triggers.ts`) no se
     relaja en esta tarea.
2. **Varios mensajes:** schema de salida v3 con `replies: string[]` (1 o 2, cada uno de hasta 1 o 2
   oraciones; `reply` desaparece). El modelo **elige** cuántos: por defecto 1. Dos solo cuando son dos cosas
   distintas, como una respuesta y una pregunta aparte, o una respuesta con un dato y un comentario, y
   nunca dos para un saludo o una respuesta corta. El eval mide que la mayoría de los turnos salga en 1. `decide()` controla **cada parte** con `checkReply` y también la
   concatenación (los topes de largo valen para el total). Si una parte falla, no sale ninguna; se deriva como
   hoy (la reformulación ante un bloqueo es la tarea 015).
   - `sendAiReply` encola una fila por parte, con `idempotencyKey` `ai:<messageId>:<n>`, en la misma
     transacción.
   - Las partes de una misma respuesta usan su propio "escribiendo…" (`typingDelayMs`) en lugar de
     `SAME_CHAT_GAP_MS`. **Decisión a registrar en `docs/decisiones.md`**: si la espera entre partes se
     acorta, y cuánto, por el riesgo de bloqueo de la conexión no oficial.
   - Si entra un mensaje del cliente o responde una persona entre parte y parte, las partes que faltan no
     se envían.
3. **`after_fields`:** el `intro` del disparador va solo en la primera pregunta (`afterFieldsAsks === 0`);
   las siguientes van sin él.
4. **Evals nuevos** (en `casos/ceramicos/` y `casos/inmobiliaria/`):
   - solo saluda;
   - saluda y pregunta;
   - pregunta de horario o envío sin pregunta de logística agregada;
   - "¿tienen porcelanato símil madera?" con catálogo (no deriva);
   - "¿hay stock del X para retirar hoy?" (deriva o pide datos, según el modo);
   - cliente que no contesta una pregunta (no se repite);
   - cliente que da un dato en el mismo mensaje en que pregunta otra cosa ("busco para el baño, 2x3,
     ¿tienen gris?"): no se le vuelve a preguntar el ambiente ni los m²;
   - respuesta en dos partes, y respuestas simples que tienen que salir en una sola.

   Nuevas expectativas en el runner: `max_partes` y `sin_pregunta`. `max_preguntas: 1` va en todos los
   casos nuevos.

## Criterios de aceptación

- [ ] Existe `prompts/v3/` y la v2 no cambió (`git diff` sin cambios en `prompts/v2/`).
- [ ] En los evals de saludo, ninguna respuesta tiene un "?" de calificación; en todos los casos de v3 hay
      como mucho una pregunta por turno.
- [ ] "¿Tienen porcelanato símil madera?" con catálogo responde sin derivar; la pregunta de stock para
      retirar sigue derivando (o pidiendo datos, si el modo es `after_fields`).
- [ ] Una respuesta de 2 partes genera 2 filas en `outbound_messages` con claves `ai:<id>` y `ai:<id>:1` (la primera conserva la clave de siempre: plan aprobado por el usuario, decisión #65).
      Un reintento del trabajo no duplica ninguna, y una parte que falla los controles bloquea todas
      (tests e2e).
- [ ] El `intro` de un `after_fields` aparece solo en la primera pregunta (test de `decide`).
- [ ] Una respuesta con `asks_field` de un campo ya obtenido no sale tal cual (test de `decide`); en los
      evals, 0 repreguntas de datos ya dados.
- [ ] En los evals de saludo y de respuesta simple sale un solo mensaje.
- [ ] Evals v3 contra la línea base v2: no baja la precisión de puntaje ni de disparadores, siguen en 0 las
      respuestas a leads calientes y no aparecen respuestas que nieguen ser un asistente.
- [ ] Decisión de la espera entre partes registrada en `docs/decisiones.md`.

## Verificación (obligatoria)

1. `npm run lint && npm run typecheck` → sin errores.
2. `npm run test` → todo verde, con los tests nuevos de `decide`, `checkReply` por partes y el envío en
   partes.
3. `npm run evals -- --model deepseek/deepseek-v4.1-flash --max-usd 0.30`, con v2 (línea base) y con v3 →
   tabla comparativa en el entregable.
4. Prueba real por WhatsApp con la config conversacional: saludo solo, saludo + pregunta, consulta de
   catálogo y pedido de stock.

## Fuera de alcance

- Que el agente diga o dé a entender que es una persona (la regla IDENTIDAD y `denies_assistant` quedan
  igual).
- El panel para editar la config (tarea 012).
- Controles de salida y reformulación (015), robustez del pipeline (016), modo acompañante y textos
  contextuales (017), audios (018), contexto del contacto (019), extracción (020), categorización (021) y
  fotos del catálogo (022).
- Transcribir audios o ver fotos.
- Relajar el detector en código de disparadores críticos o los controles de salida.

## Entregable

Resumen con:

- los archivos tocados;
- el resultado de cada punto de la verificación, con la tabla de evals v2 contra v3;
- el veredicto de `revisor-codigo` y de `revisor-seguridad`;
- las decisiones tomadas que no estaban en la tarea.
