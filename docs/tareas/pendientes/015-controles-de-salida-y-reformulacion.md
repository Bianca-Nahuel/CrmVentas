# Tarea 015: controles de salida menos restrictivos y reformulación ante un bloqueo

## Contexto

Decisión #63 de `docs/decisiones.md`. Hoy, cuando una respuesta falla un control de salida
(`reply/output-checks.ts`), la conversación se deriva. Varios controles bloquean palabras comunes, así que
respuestas correctas terminan en una derivación. Comprobado el 2026-10-27 con la config de cerámicos:

| Respuesta                                                                  | Control que la bloquea                      |
| -------------------------------------------------------------------------- | ------------------------------------------- |
| "No hacemos descuentos, pero hay cuotas sin interés con algunas tarjetas." | `commitment` (por "descuento")              |
| "Estamos disponibles de lunes a viernes de 9 a 17:30."                     | `commitment` (por "disponib", con catálogo) |
| "El stock no te lo puedo confirmar yo, eso lo ve un vendedor."             | `commitment` (por "stock")                  |
| "Para un baño de 2x3 serían unos 6 m2 más un 10% por cortes."              | `quantity` (m² que el cliente no escribió)  |

También derivan:

- una salida que no valida (`invalid_output`, `truncated`);
- una respuesta de más de 500 caracteres (`max_length`).

## Objetivo

- Los controles bloquean **lo que la respuesta afirma o promete**, no palabras sueltas.
- Ante un bloqueo, el modelo recibe el motivo y tiene **una** oportunidad de reformular. Si vuelve a
  fallar, se deriva como hoy.

## Antes de empezar

1. Leé `CLAUDE.md`, el skill `cambio-prompt-ia` y `.claude/rules/ia.md`.
2. Leé `reply/output-checks.ts`, `reply/decide.ts`, `reply/reply-engine.ts`, `reply/ai-reply.service.ts`,
   `llm/llm-client.ts` y sus tests.
3. Si la 010 ya está hecha, trabajá sobre `replies[]` (cada parte se controla igual).
4. Corré los evals y guardá la línea base.

## Pasos / requisitos

1. **Controles por afirmación**, con tests de los casos de la tabla y de los que tienen que seguir
   bloqueando:
   - `commitment` y disponibilidad: una negación o una aclaración de que no se puede ("no hacemos
     descuentos", "no te puedo confirmar el stock", "eso lo ve un vendedor") no bloquea. Siguen bloqueando
     las afirmaciones ("te hago un descuento", "hay stock", "te lo reservo", "llega mañana").
   - "Disponible" referido a horarios o a la atención no bloquea.
   - `quantity`: se permiten los m² que salen de medidas que dio el cliente (largo × ancho, más el
     porcentaje de corte de la config) si el cálculo da. Cajas y piezas siguen yendo solo con marcas.
   - `money`: los porcentajes y montos que figuran en la config siguen permitidos; el resto sigue
     bloqueando.
   - Sin cambios en: links, emails, teléfonos, datos sensibles, `denies_assistant`, `leak` y marcas.
2. **Reformulación:** si `checkReply` falla, se hace una segunda llamada al modelo con la misma
   conversación más un mensaje del sistema. Ese mensaje dice qué control falló y por qué, con una
   explicación por control (por ejemplo, "no escribas montos: usá la marca"), **sin** repetir el texto
   bloqueado si contiene datos sensibles.
   - Si la segunda respuesta pasa, se envía. Si falla, se deriva con `blocked:<control>`, como hoy.
   - Va en la misma corrida y en el mismo presupuesto (el `AiBudgetGuard` reserva para la segunda
     llamada).
   - En `ai_runs` quedan las dos salidas y `retried: <control>`.
3. **Salida inválida o cortada:** un reintento de la llamada antes de derivar.
4. **Largo:** si solo falla `max_length`, se pide reformular más corto, o se reparte en 2 partes si la 010
   ya está. Nunca se corta el texto a la mitad.
5. Constante `AI_REFORMULATE_MAX = 1` en `ai.constants.ts`.

## Criterios de aceptación

- [ ] Los 4 textos de la tabla pasan los controles; los de afirmación (descuento, stock, reserva, fecha de
      entrega) siguen bloqueando (tests de `checkReply`).
- [ ] Una respuesta bloqueada con una reformulación válida se envía sin derivar; con dos fallas deriva con
      `blocked:<control>` (test de `ai-reply` con un cliente de modelo falso).
- [ ] `invalid_output` reintenta una vez antes de derivar.
- [ ] El mensaje de reformulación no incluye texto del cliente ni datos sensibles (test).
- [ ] Evals: menos derivaciones `blocked:*` que la línea base, 0 respuestas a calientes y 0 promesas.

## Verificación (obligatoria)

1. `npm run lint && npm run typecheck` → sin errores.
2. `npm run test` → verde, con los tests nuevos.
3. `npm run evals -- --max-usd 0.30`, antes y después → tabla con las derivaciones por motivo.

## Fuera de alcance

- Cambiar los disparadores o el detector en código.
- Los controles de links, teléfonos, datos sensibles e identidad.

## Entregable

Resumen con:

- los archivos tocados;
- el resultado de la verificación y la tabla de evals;
- el veredicto de `revisor-codigo` y de `revisor-seguridad`;
- las decisiones tomadas que no estaban en la tarea.
