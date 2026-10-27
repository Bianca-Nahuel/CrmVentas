# Tarea 019: contexto del contacto (nombre del perfil, conversaciones anteriores y memoria larga)

## Contexto

Decisión #63 de `docs/decisiones.md` (puntos 15, 16, 22 y 23 del análisis del 2026-10-27).

- WhatsApp trae el nombre del perfil (`contacts.profile_name`), pero el modelo nunca lo ve y termina
  preguntando el nombre.
- Una conversación nueva del mismo contacto arranca de cero.
- El modelo ve solo los últimos 20 mensajes, así que lo que no quedó como dato extraído se olvida.
- Los productos consultados no quedan asociados al lead.

## Objetivo

Que el agente sepa con quién habla y no le haga repetir nada:

- el nombre del perfil, si parece un nombre;
- los datos de conversaciones anteriores;
- un resumen corrido de la conversación;
- los productos de interés.

## Antes de empezar

1. Leé `CLAUDE.md`, los skills `cambio-prompt-ia` y `migracion-db`, y `.claude/rules/ia.md`.
2. Leé `prompts/v*/tenant-layer.ts` (`buildClientData`), `ai-reply.service.ts` (`lockSnapshot`,
   `loadHistory`) y el schema de `contacts` y `conversations`.

## Pasos / requisitos

1. **Nombre del perfil:** validación en código, con tests de casos reales:
   - se normaliza, se sacan los emojis y queda solo la primera palabra;
   - se acepta solo si tiene letras (cualquier alfabeto), apóstrofo o guion, entre 2 y 20 caracteres, sin
     dígitos, `@` ni links;
   - no puede ser una palabra genérica o comercial (por ejemplo "ventas", "admin", "materiales",
     "construcciones", "srl", "sa", "obra"). La lista va en `libs/shared` y es la misma para todas las
     empresas.

   Va en `<datos_del_cliente>` como `nombre_de_perfil` (no confirmado), nunca en el prompt de sistema.
   - La capa fija: usarlo con moderación; si el cliente dice otro nombre, vale el que dijo; nunca darlo por
     dato verificado.
   - Si el campo `nombre` de la config está vacío, el nombre del perfil **no** lo completa, pero el modelo
     no lo pregunta salvo que haga falta.

2. **Conversaciones anteriores del mismo contacto** (misma empresa, con RLS):
   - los datos extraídos, lo descubierto, el último resumen y la fecha de la última conversación van en
     `<datos_del_cliente>` como `antes`;
   - los datos de más de N días (constante, por ejemplo 180) no se pasan;
   - el modelo puede confirmarlos ("¿seguís con lo del baño?") en lugar de preguntarlos de cero.
3. **Resumen corrido:**
   - columna `running_summary` en `conversations` (migración con grants por columna);
   - el modelo la actualiza en cada turno (campo nuevo de la salida, hasta 600 caracteres, sin datos
     sensibles) y se pasa en `<datos_del_cliente>`;
   - reemplaza a los mensajes que quedan fuera de los 20.
4. **Productos de interés:**
   - los SKU que devolvió `ver_producto` en la conversación se guardan en la conversación (hasta 10, los
     más recientes) y se pasan como `productos_consultados`;
   - el resumen de derivación los incluye.
5. Todo lo que viene del cliente sigue siendo dato, nunca instrucción (escape y sección propia).

## Criterios de aceptación

- [ ] La validación del nombre acepta "Martín", "Ana 🌸" (→ Ana) y "José Luis" (→ José), y rechaza
      "Ventas Norte", "Construcciones SRL", "👍", "Juan123" y "www.x.com" (tests).
- [ ] Un contacto que vuelve no recibe preguntas de datos que dio en la conversación anterior (eval).
- [ ] El resumen corrido se actualiza y aparece en el prompt; con más de 20 mensajes, un dato del principio
      no se repregunta (eval).
- [ ] Los SKU consultados quedan en la conversación y en el resumen de derivación (test).
- [ ] RLS: un contacto de otra empresa nunca aparece (test de aislamiento).

## Verificación (obligatoria)

1. `npm run lint && npm run typecheck` → sin errores.
2. `npm run db:migrate` y `npm run test` → verde.
3. `npm run evals -- --max-usd 0.30` → sin regresión, con los casos nuevos.

## Fuera de alcance

- Ver o editar estos datos en el panel (tareas 012 y 014).
- Fusionar contactos duplicados.

## Entregable

Resumen con:

- los archivos tocados;
- el resultado de la verificación;
- el veredicto de `revisor-codigo` y de `revisor-seguridad`;
- las decisiones tomadas.
