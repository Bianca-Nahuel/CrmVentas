# Tarea 017: modo acompañante después de derivar y textos redactados según el contexto

## Contexto

Decisión #63 de `docs/decisiones.md`. Hoy, después de derivar (`handed_off_at`), la IA no vuelve a escribir.
Si el vendedor tarda, el cliente queda hablándole a la pared, sobre todo con la derivación fuera de
horario.

Además, los textos de derivación, de fuera de horario y de las preguntas de un disparador `after_fields`
son fijos (`handoff.message_*`, `intro` + `how_to_ask`), iguales para todos los clientes.

**Esta tarea cambia una regla de `CLAUDE.md`** ("después de derivar ya no escribe salvo el texto fijo"): al
cerrarla, se actualizan `CLAUDE.md` y `.claude/rules/ia.md`.

## Objetivo

- Después de derivar, y hasta que una persona escriba en la conversación, la IA sigue respondiendo dudas de
  información del negocio. No califica, no sugiere ventas y no cierra nada.
- Los textos de derivación y las preguntas de los disparadores los redacta la IA según la conversación. El
  texto de la config queda como respaldo.

## Antes de empezar

1. Leé `CLAUDE.md`, los skills `cambio-prompt-ia` y `migracion-db`, y `.claude/rules/ia.md`.
2. Leé `reply/ai-reply.service.ts` (`filter`, `handOff`), `reply/decide.ts` y la capa fija vigente
   (v3 si la 010 está hecha).
3. Corré los evals y guardá la línea base.

## Pasos / requisitos

1. **Estado acompañante:** una conversación derivada sin ningún mensaje humano (`sender_type = 'user'`)
   posterior a `handed_off_at` está en modo acompañante.
   - El primer mensaje humano la saca de ese modo para siempre, además de la pausa de 12 h que ya existe.
   - Se calcula a partir de los mensajes, sin columna nueva salvo que haga falta por rendimiento (en ese
     caso, migración con su RLS y sus grants).
2. **Prompt del modo acompañante** (sección de la capa fija):
   - solo responde información del negocio y del catálogo;
   - no pregunta datos ni hace sugerencias;
   - si el cliente pide algo que es del vendedor (precio final, reserva, pago, stock no informable),
     responde que ya lo tiene el vendedor, sin prometer plazos;
   - si pregunta si lo van a atender, responde que el vendedor ya tiene la consulta.
3. **`decide()` en modo acompañante:**
   - los disparadores no vuelven a derivar (ya está derivada), pero se registran y se suman al resumen
     para el vendedor;
   - el puntaje y lo extraído se siguen actualizando;
   - se mantienen todos los controles de salida.
4. **Textos contextuales:**
   - Al derivar, el texto que se envía es una respuesta redactada por el modelo en ese turno (`reply`, que
     en v3 se pide también cuando hay derivación), si pasa los controles. Si no hay o no pasa, va el texto
     de la config.
   - En `after_fields`, la pregunta la redacta el modelo, con el campo que `decide()` le indica (o se valida
     con `asks_field`). Si no pregunta ese campo o no pasa los controles, va `intro` + `how_to_ask`.
   - Con `unsupported_media`, lo mismo cuando hay texto del modelo. Si no lo hay, el de la config.
5. Idempotencia: el texto de derivación sigue saliendo una sola vez por conversación
   (`handoff:<conversationId>`).

## Criterios de aceptación

- [ ] Después de derivar, una pregunta de horario o de un producto recibe respuesta; después de un mensaje
      del vendedor, no (tests e2e).
- [ ] En modo acompañante no se hacen preguntas de calificación ni sugerencias (evals nuevos en dos rubros).
- [ ] El texto de derivación varía según la conversación y, si el modelo no da uno válido, sale el de la
      config (tests de `decide`).
- [ ] `CLAUDE.md` y `.claude/rules/ia.md` actualizados con la regla nueva.
- [ ] Evals sin regresión: 0 respuestas a calientes fuera del modo acompañante y 0 promesas.

## Verificación (obligatoria)

1. `npm run lint && npm run typecheck` → sin errores.
2. `npm run test` → verde.
3. `npm run evals -- --max-usd 0.30` → comparación con la línea base.
4. Prueba real: derivar, preguntar el horario (responde), escribir desde el teléfono del vendedor y volver a
   preguntar (no responde).

## Fuera de alcance

- Escalar a otro vendedor o avisar que el vendedor tarda.
- Reactivar la IA completa en una conversación derivada (tarea 014).

## Entregable

Resumen con:

- los archivos tocados;
- el resultado de la verificación;
- el veredicto de `revisor-codigo` y de `revisor-seguridad`;
- las decisiones tomadas.
