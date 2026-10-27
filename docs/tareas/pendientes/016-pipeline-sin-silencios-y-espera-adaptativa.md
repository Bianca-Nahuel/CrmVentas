# Tarea 016: reintento ante errores del modelo, visto solo al responder y espera adaptativa

## Contexto

Decisión #63 de `docs/decisiones.md`. En el pipeline `ai-reply` (`reply/ai-reply.service.ts`) pasan tres
cosas:

- Un error de transporte de OpenRouter (`error:unavailable`, timeout) se registra y el cliente queda sin
  respuesta hasta que vuelve a escribir. Esto figura en la deuda de la 007.
- El visto y el "escribiendo…" arrancan mientras el modelo piensa (`PresenceService`, decisión de la 006).
  Si al final no hay respuesta, el cliente ve los tildes azules y el indicador se corta sin mensaje.
- La espera antes de responder es fija (`AI_DEBOUNCE_SECONDS = 10`).

## Objetivo

- Un error de transporte se reintenta una vez. Si vuelve a fallar, no se envía nada.
- El visto y el "escribiendo…" se muestran solo cuando hay algo para mandar.
- La espera se adapta a cómo escribe el cliente.

## Antes de empezar

1. Leé `CLAUDE.md`, el skill `webhook-whatsapp` y `.claude/rules/whatsapp.md`.
2. Leé `reply/ai-reply.service.ts`, `ai-reply.worker.ts`, `messaging/outbound/presence.service.ts`,
   `outbound.constants.ts` y la encolada del trabajo en `whatsapp/inbound/`.
3. Leé las decisiones #33, #42 y la deuda de la 006 y la 007 en `docs/decisiones.md`.

## Pasos / requisitos

1. **Reintento:** ante un error de transporte (no `invalid_output`), el trabajo se reintenta una vez, a
   los 5–10 s.
   - Antes de reintentar se vuelven a correr los filtros: si llegó un entrante nuevo, respondió una persona
     o se pausó, no se reintenta.
   - Si el segundo intento falla, queda `error:<tipo>` y no se envía nada.
   - El detalle técnico (código HTTP, `finish_reason`) se guarda en `ai_runs`, sin datos personales.
2. **Visto solo al responder:** `startTyping` pasa de antes de la llamada al modelo a después de la
   decisión, solo si hay una respuesta o un texto de derivación.
   - La demora de "escribiendo…" del envío se aplica completa.
   - Medí la latencia nueva contra los ~19 s de hoy y registrala en `docs/decisiones.md`.
3. **Espera adaptativa**, en lugar de los 10 s fijos. Valores iniciales en constantes, para ajustar con
   pruebas reales:
   - el último mensaje termina en "?" y tiene más de 15 caracteres → 5 s;
   - el último mensaje es corto (menos de 25 caracteres) y no termina en puntuación, o termina en "," o en
     "y" → 15 s;
   - llegó otro mensaje del cliente hace menos de 8 s → se suma la espera otra vez;
   - siempre con un tope de 25 s desde el primer mensaje de la ráfaga.

   Va como `startAfter` del trabajo. Sigue valiendo que lo procesa el trabajo del entrante más nuevo.

4. Tests con reloj controlado para cada regla de espera, y del reintento con un cliente de modelo falso.

## Criterios de aceptación

- [ ] Un error de transporte seguido de un éxito envía la respuesta; dos errores no envían nada y dejan
      `error:<tipo>` con su detalle (test).
- [ ] Un turno que termina en `none` o en error no marca visto ni pone "escribiendo…" (test con el
      proveedor falso).
- [ ] Las reglas de espera dan los valores definidos (tests unitarios).
- [ ] La prueba real por WhatsApp responde y la latencia queda registrada.

## Verificación (obligatoria)

1. `npm run lint && npm run typecheck` → sin errores.
2. `npm run test` → verde.
3. Prueba real: pregunta completa (respuesta rápida), mensaje partido en 3 (una sola respuesta) y OpenRouter
   caído simulado (sin mensaje).

## Fuera de alcance

- La pausa de 12 h tras un mensaje humano (se mantiene).
- Avisarle al cliente que hubo un error.

## Entregable

Resumen con:

- los archivos tocados;
- el resultado de la verificación, con la latencia antes y después;
- el veredicto de `revisor-codigo` y de `revisor-seguridad`;
- las decisiones tomadas.
