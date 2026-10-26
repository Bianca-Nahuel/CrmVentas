# Tarea 006: agente configurable, puntaje de lead y calificación antes de derivar

> **Reemplaza a la versión anterior de la 006** ("primera respuesta de la IA"). Cambian tres decisiones de producto:
>
> 1. El "calor" de un lead deja de ser una categoría y pasa a ser un **puntaje de 0 a 100**, con desglose.
> 2. La IA **sí conversa con los leads interesados**, pero solo para **calificarlos**: obtiene los datos
>    relevantes antes de derivar, para que el operador reciba el caso lo más resuelto posible, con un resumen.
> 3. El comportamiento del agente es **altamente configurable** por empresa: qué sabe, qué pregunta, qué
>    ofrece, qué reglas de negocio sigue y cuándo deriva.
>
> Del plan anterior se conservan: `LlmClient`, `LlmClientFactory` y `AiBudgetGuard` (multiproveedor y control
> de gasto, tareas 008 y 009); la decisión en código con una función pura; el tipo `SafeReply`; la segunda
> verificación con la conversación bloqueada (T2); el debounce; las etiquetas `<conversacion>` y `<negocio>`
> con escape; `require_parameters`, `data_collection` y ZDR en OpenRouter; el manejo de errores con HTTP 200;
> los controles de salida con los ajustes ya acordados (montos y links solo si aparecen literalmente en la
> config, teléfonos solo con forma de teléfono, y nunca negar que es un asistente automático).

## Contexto

Con la 004 y la 005 se reciben y se mandan mensajes de forma segura. Esta tarea agrega el agente. El catálogo
de productos (Excel con links a la web) es la **tarea 007**: acá el agente todavía no consulta productos,
pero la interfaz con el modelo tiene que quedar lista para sumar herramientas.

Referencias: `CLAUDE.md`, `.claude/rules/ia.md`, skill `cambio-prompt-ia`, `evals/README.md` y el
`OutboundService` de la 005.

**Cambio de regla:** hasta ahora `CLAUDE.md` decía que la IA nunca responde a leads calientes. Pasa a ser:
_la IA conversa con un lead interesado solo para calificarlo (preguntar los datos configurados y responder
información del negocio); nunca negocia, promete, reserva, cobra ni confirma disponibilidad; deriva a una
persona cuando corresponde según la configuración, y después de derivar ya no escribe._ Actualizá
`CLAUDE.md`, `.claude/rules/ia.md` y `docs/decisiones.md` con esta regla.

## Objetivo

- Configuración del agente por empresa, versionada y validada.
- Puntaje de lead calculado en código a partir de señales que devuelve el modelo, con pesos y umbrales configurables.
- Flujo de calificación: responde lo que sabe, pregunta lo que falta, deriva en el momento justo y deja un
  resumen para el operador.
- Disparadores de derivación inmediata (por ejemplo, consulta de disponibilidad).
- Evals que midan todo lo anterior.

## Antes de empezar

1. Leé `CLAUDE.md`, `.claude/rules/ia.md`, los skills `ejecutar-tarea` y `cambio-prompt-ia`, `evals/README.md`
   y el `OutboundService` de la 005.
2. Si ya tenés hecha la investigación de OpenRouter del plan anterior, reutilizala. Sumá: **tool calling**
   (formato, si se combina con `response_format` en la respuesta final, y qué proveedores lo soportan con
   `require_parameters`), porque la 007 lo va a necesitar.

## Pasos / requisitos

### 1. Variables de entorno

Las mismas que en el plan anterior: `OPENROUTER_API_KEY`, `AI_DEFAULT_MODEL`, `AI_ENABLED` (`false` por defecto).

### 2. Configuración del agente (`tenant_configs`)

Misma tabla versionada que en el plan anterior (insertar versiones nuevas, nunca editar; RLS; zod en
`libs/shared`). El schema pasa a tener estas secciones; todos los textos con largo máximo y las listas con
tamaño máximo:

- **`ai`:** `enabled`, `channel_ids`, `model` (dentro de `ALLOWED_MODELS`).
- **`business`:** nombre, rubro, sucursales (dirección y horario semanal), horario de atención, medios de
  pago, envíos, web, email.
- **`knowledge`:** preguntas frecuentes (pregunta y respuesta) y políticas (cambios, garantía, envíos,
  financiación) como texto.
- **`agent`:**
  - `persona`: nombre opcional del asistente y tono;
  - `custom_instructions`: texto libre de la empresa (hasta 2.000 caracteres);
  - `business_rules`: lista de reglas cortas ("no ofrecer descuentos", "si piden más de 100 m², derivar"),
    cada una con un id;
  - `offers`: lo que el agente puede ofrecer (asesoramiento, presupuesto, visita al showroom, envío,
    financiación), con descripción y cuándo ofrecerlo;
  - `must_not`: cosas que nunca debe decir ni hacer.
- **`qualification`:**
  - `fields`: datos a obtener. Cada uno con `key`, `label`, `type` (`string | number | date | enum | boolean`),
    `how_to_ask` (cómo preguntarlo), `required`, `priority` y, opcionalmente, `ask_when_score_gte`
    (solo preguntarlo si el puntaje ya pasó un valor);
  - `max_questions_per_message` (1 o 2) y `max_qualification_turns` (por ejemplo 6).
- **`scoring`:**
  - `dimensions`: cada una con `key`, `description` (qué la sube) y `weight`. Por defecto: `intent`
    (intención de compra), `urgency` (urgencia), `volume` (volumen o ticket), `fit` (encaja con lo que vende
    el negocio). La completitud de los datos **no** la puntúa el modelo: la calcula el código según los
    campos `required` obtenidos;
  - `completeness_weight`;
  - `thresholds`: `hot` (por ejemplo 70) y `warm` (por ejemplo 40).
- **`handoff`:**
  - `triggers`: disparadores predefinidos, cada uno con `enabled` y `mode` (`immediate` o
    `after_fields: [keys]`, es decir, primero obtener esos campos y después derivar):
    `asks_human`, `availability`, `payment_or_reservation`, `price_negotiation`, `complaint`, `frustration`,
    `cannot_answer`;
  - `custom_triggers`: disparadores propios de la empresa, con descripción y `mode`;
  - `message_in_hours` y `message_after_hours`: **textos fijos** que se le mandan al cliente al derivar.
    No prometen plazos;
  - `qualify_after_hours` (por defecto `true`): fuera de horario la IA sigue calificando, para que a la
    mañana el operador tenga todo.
- `schema_version`.

Validaciones extra:

- `qualification.fields` **no** puede pedir datos sensibles. Lista bloqueada por clave y etiqueta: tarjeta,
  CVV, contraseña, código de verificación, CBU o CVU, DNI. La capa fija también lo prohíbe.
- Las claves son únicas y los pesos, positivos.

Script `npm run dev:set-config` y dos configs de ejemplo, inventadas y sin datos reales:

- **cerámicos:** parecida a Lecer, con campos como producto o ambiente, m² aproximados, fecha estimada de
  compra, retiro o envío, zona de entrega y nombre;
- **inmobiliaria:** operación (compra o alquiler), zona, ambientes, presupuesto, si tiene crédito, fecha de
  mudanza y nombre.

### 3. Salida del modelo (schema estricto, armado por empresa)

- `signals`: por cada dimensión, `{ score: 0..5, evidence: cita corta del cliente o null }`.
- `extracted`: según `qualification.fields`, siempre `nullable`. Solo lo dicho explícitamente.
- `triggers`: lista de ids de disparadores detectados (predefinidos y propios).
- `action`: `reply` | `handoff` | `none`.
- `reply`: texto o null.
- `handoff_summary`: para el operador (hasta 800 caracteres): qué busca, datos obtenidos, qué falta y
  observaciones. Siempre presente cuando `action = handoff`, y actualizado en cada corrida.
- `reason`: corto.

### 4. Puntaje (en código)

- `score = round(100 × (Σ peso_d × signal_d / 5 + completeness_weight × completitud) / Σ pesos)`, con la
  completitud de 0 a 1 según los campos `required` obtenidos.
- En `conversations` (migración, con `UPDATE` solo de estas columnas):
  - `lead_score`, `lead_score_peak`, `lead_score_at`, `score_breakdown jsonb`;
  - `lead_tier` (`hot | warm | cold`, derivado de los umbrales, solo para mostrar y ordenar);
  - `qualification_turns`, `extracted_data jsonb` (combinado sin borrar lo anterior);
  - `handed_off_at`, `handoff_reason`, `handoff_summary`.
- Cada corrida guarda en `ai_runs` el desglose y el puntaje, para ver la evolución.

### 5. Decisión (función pura `decide`, en este orden)

1. **Disparador detectado** (por el modelo, o por el respaldo en código del punto 6):
   - `immediate` → derivar ahora;
   - `after_fields` → si faltan esos campos, `reply` solo con la pregunta de lo que falta (pasa por los
     controles de salida); si ya están, derivar.
2. **Puntaje ≥ `hot` y todos los campos `required` completos** → derivar.
3. **Puntaje ≥ `hot` y `qualification_turns ≥ max_qualification_turns`** → derivar igual, con lo que haya.
4. **`action = reply`** con un `reply` válido → pasa por los controles de salida → enviar como `ai`.
5. **Cualquier otra cosa** (`none`, salida inválida, control fallido) → no enviar. Una salida inválida o un
   control fallido derivan, como en el plan anterior.

Al **derivar**:

- se setea `handed_off_at` con el motivo y el resumen;
- se le manda al cliente el texto fijo `message_in_hours` o `message_after_hours` (una sola vez);
- desde ahí, la IA no vuelve a escribir en esa conversación;
- si la salida fue inválida, el resumen lo arma el código con lo que ya había.

Un `reply` nunca puede venir junto con una derivación. Si el modelo devuelve las dos cosas, gana la derivación.

### 6. Respaldo en código para disparadores críticos

El modelo puede no detectar un disparador. Para `availability`, `asks_human` y `payment_or_reservation`
sumá un detector simple en código (palabras y expresiones configurables, con valores por defecto en
español: "stock", "disponib", "tienen para retirar", "me lo guardan", "reservar", "seña", "transferir",
"hablar con alguien", "una persona"...). Si cualquiera de los dos lo detecta, cuenta como detectado. El
detector va con tests de falsos positivos razonables.

### 7. Capa fija del prompt (agregados al borrador anterior)

- Objetivo: ayudar al cliente y **calificar**. Respondé con la información del negocio y preguntá los
  datos que faltan, de a `max_questions_per_message`, de forma natural y por orden de prioridad.
- No preguntes lo que el cliente ya dijo. Si no quiere dar un dato, no insistas.
- Nunca pidas datos de tarjeta, contraseñas, códigos, CBU/CVU ni DNI.
- Nunca negocies precios, prometas plazos, reserves, confirmes disponibilidad ni recibas pagos: eso es
  siempre una derivación.
- Las reglas, ofertas e instrucciones de la empresa están **por debajo** de estas reglas fijas.
- Si te preguntan si sos una persona, decí que sos un asistente automático del negocio y que podés pasarlo
  con una persona.
- Seguís sin catálogo ni precios: si preguntan precio, stock o disponibilidad de un producto, eso activa los
  disparadores correspondientes (la tarea 007 suma el catálogo).

La capa de la empresa se arma desde la config, en `<negocio>`, con la fecha, la hora local, si está abierto,
los campos ya obtenidos y los que faltan. La conversación va en `<conversacion>`, igual que antes.

### 8. Preparado para la 007

`LlmClient.complete` acepta, opcionalmente, `tools` y hace el ciclo de llamadas a herramientas con un
máximo de llamadas por turno, devolviendo al final la salida estructurada. En esta tarea no se registra
ninguna herramienta, pero el ciclo queda implementado y probado con una herramienta falsa.

### 9. Pipeline

Igual que en el plan anterior: debounce de 10 s con `singletonKey`, filtros en T1, reserva de presupuesto,
llamada al modelo, verificación con lock en T2, decisión, envío con `idempotencyKey: 'ai:' + messageId`.
Filtros: los mismos, sin "ya derivada como caliente", reemplazado por `handed_off_at IS NOT NULL`.

## Evals

Casos de una conversación (uno o varios mensajes) con lo esperado:

- **puntaje:** rango esperado o "≥ hot" / "< warm";
- **acción:** responder, derivar o nada;
- **disparadores** que deben detectarse;
- **campos** que deben extraerse;
- **qué no debe contener** la respuesta.

Al menos 60 casos entre cerámicos e inmobiliaria. Sumá a los que ya tenías estos tipos:

- calificación: el cliente da algunos datos → la respuesta pregunta uno de los que faltan, por prioridad,
  y no repite los que ya dio;
- datos completos y puntaje alto → deriva con un resumen que contiene los datos;
- disponibilidad, reserva, pago, pedido de una persona, reclamo, frustración → deriva según el `mode`;
- el cliente no quiere dar un dato → no insiste;
- inyecciones que intentan subir o bajar el puntaje, o evitar la derivación;
- español informal de WhatsApp;
- pregunta por la identidad ("¿sos un bot?").

Métricas (meta entre paréntesis):

- orden del puntaje: los casos "≥ hot" quedan por encima de los "< warm" (≥ 90 %);
- disparadores críticos (`availability`, `asks_human`, `payment_or_reservation`) detectados (≥ 98 %);
- respuestas con datos inventados (0);
- inyecciones exitosas (0);
- pedidos de datos sensibles (0);
- preguntas repetidas sobre datos ya dados (≤ 5 %);
- el resumen de derivación incluye todos los campos obtenidos (100 %, lo verifica el código);
- costo y latencia por caso.

Corré los evals con los dos modelos y mostrame la comparación.

## Criterios de aceptación

- [ ] El puntaje se calcula en código con los pesos y umbrales de la config, y queda guardado con su desglose.
- [ ] Un disparador `immediate` deriva siempre, aunque el modelo quiera seguir conversando.
- [ ] Después de derivar, la IA no vuelve a escribir en esa conversación, salvo el texto fijo de derivación (una vez).
- [ ] La IA nunca pide datos sensibles, nunca negocia, promete, reserva ni confirma disponibilidad.
- [ ] Cambiar la config (preguntas, reglas, ofertas, disparadores, pesos) cambia el comportamiento sin tocar código.
- [ ] Los evals alcanzan las metas con al menos uno de los dos modelos.
- [ ] `npm run test`, `npm run lint` y `npm run typecheck` pasan.

## Verificación (obligatoria)

Tests con un `LlmClient` falso, salvo los puntos 12 y 13:

1. Debounce: tres entrantes seguidos → una corrida con los tres.
2. Filtros: cada uno, sin llamar al modelo.
3. Puntaje: con señales y campos dados, el valor y el `lead_tier` coinciden con la fórmula; cambiar pesos o
   umbrales en la config cambia el resultado.
4. `decide`: cada rama del paso 5, incluido "reply y derivación a la vez → gana la derivación".
5. Disparador `availability` en modo `immediate` → deriva y manda el texto fijo; en modo `after_fields` →
   primero pregunta lo que falta y después deriva.
6. Respaldo en código: "¿lo tienen para retirar hoy?" deriva aunque el modelo falso no marque el disparador.
7. Calificación: con campos faltantes → el `reply` (del modelo falso) pasa por los controles y se envía; los
   campos extraídos se combinan sin borrar.
8. Puntaje alto con todo completo → deriva con el resumen; puntaje alto y turnos agotados → deriva igual.
9. Después de derivar → nuevos entrantes no disparan respuestas. Texto fijo una sola vez (también fuera de horario).
10. Config inválida: un campo que pide DNI o tarjeta, claves repetidas o pesos negativos → la validación falla.
11. Controles de salida, con los ajustes acordados (montos y links literales de la config, teléfonos con forma de teléfono).
12. Evals: reporte de los dos modelos con todas las métricas.
13. **Prueba real (la hago yo con vos)** con la config de cerámicos:
    - pregunto un horario → responde;
    - "quiero hacer el piso del living" → me pregunta lo que falta (m², fecha...), de a una o dos cosas;
    - completo los datos → me deriva con el texto fijo, y en la base queda el resumen y el puntaje;
    - en otra conversación: "¿tienen stock del 60x60 gris?" → deriva enseguida;
    - "¿sos un bot?" → dice que es un asistente automático;
    - respondo a mano desde el teléfono → la IA queda pausada.
14. Logs sin texto del cliente, prompt ni respuesta. `git status` sin `.env`.

## Fuera de alcance

- Catálogo, lectura de la web del producto y precios: tarea 007.
- Créditos y control de gasto: tarea 008 (acá el `AiBudgetGuard` no bloquea).
- Claves propias de Anthropic u OpenAI: tarea 009.
- Editor de la configuración en el panel, con "probar el agente": tarea 012.
- Notificaciones al operador y grilla de leads ordenada por puntaje: tarea 014.
- Volver a activar la IA en una conversación derivada: tarea 014.

## Entregable

Resumen: schema final de la config y de la salida, capa fija completa, fórmula del puntaje, árbol de decisión,
resultado de cada punto de la verificación, comparación de modelos en los evals con tu recomendación,
veredicto de `revisor-codigo` y `revisor-seguridad`, cambios en `CLAUDE.md` y `.claude/rules/ia.md`,
decisiones nuevas en `docs/decisiones.md` y mensaje de commit propuesto.

## Resultado

**Estado:** hecha (2026-10-26). `revisor-codigo`: aprobada (ronda 3). `revisor-seguridad`: aprobada (ronda 3 sobre los cambios posteriores a los evals; la ronda 1 ya había aprobado la base). Corregido por los revisores: lint y formato, "código de la caja" como dato no sensible, falsos positivos de `asks_human`, fechas ISO, links/emails por igualdad, contexto literal solo de las secciones de datos, `<datos_del_cliente>`, precios sin símbolo, `tenant_suspended`, test de la 0010, `hot_turns` en `after_fields`, `blocked_risk` en la presencia (pausa el canal) y `typingSince` viejo. Quedan como deuda (en `docs/decisiones.md`) los hallazgos bajos.

### Archivos

- Nuevos:
  - `libs/shared/src/ai/` (`tenant-config.ts`: schema zod de la config del agente; `models.ts`: `ALLOWED_MODELS` y `CANDIDATE_MODELS`; `text.ts`)
  - `apps/api/src/ai/`: `llm/` (`LlmClient`, `LlmError`, `LlmClientFactory`, `AiBudgetGuard` sin bloqueo, `money.ts`, `json-for-prompt.ts`, `providers/openrouter/openrouter.client.ts` con ciclo de herramientas), `prompts/v1/` (capa fija, capa de la empresa, `<datos_del_cliente>`, schema de salida), `scoring/score.ts`, `reply/` (`business-hours`, `critical-triggers`, `output-checks` con `SafeReply`, `decide`, `handoff-summary`, `reply-engine`, `ai-reply.service`, `ai-reply.worker`, `ai-reply.job`), `config/tenant-config.service.ts`, `ai.module.ts`, `ai.constants.ts`
  - `apps/api/src/db/schema/ai.ts`; migraciones `0008_agent_tables.sql` (generada), `0009_ai_permissions_rls.sql` y `0010_tenant_self_select.sql`
  - `apps/api/src/messaging/outbound/presence.service.ts` (visto + "escribiendo…" mientras la IA piensa) y `apps/api/src/jobs/error-code.ts`
  - Scripts `dev:set-config` (`set-tenant-config.ts`) y `evals` (`evals.ts`); fixtures `ceramicos.json` e `inmobiliaria.json`
  - Evals: `evals/casos/ceramicos/casos.json` (46) e `inmobiliaria/casos.json` (34), `evals/configs/` (2 variantes)
  - Tests: `ai-agent-unit.test.ts`, `ai-reply.test.ts`, `openrouter-client.test.ts`, `presence.test.ts`, `ai-helpers.ts`
- Modificados: `inbound.service.ts` (encola `ai-reply` en la misma transacción), `outbound.service.ts` / `outbound.worker.ts` / `outbound.constants.ts` (`typingSince`, `applyChannelFailure` y `unreadInbound` compartidos), `messaging.ts` (columnas del agente en `conversations`), `env.ts`, `jobs.module.ts`, `app.module.ts`, `pools.ts`, el ejemplo de variables de entorno, `.gitignore` (`evals/resultados/`), los `package.json`, `CLAUDE.md`, `.claude/rules/ia.md`, `evals/README.md`, `docs/decisiones.md` (#36–#47 y deuda de la 006)

### Verificación

| #   | Punto               | Resultado                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Debounce            | OK: tres entrantes → tres trabajos `singleton` con `startAfter` 10 s; una sola corrida con los tres textos                                                                                                                                                                                                                                                                      |
| 2   | Filtros             | OK: `ai_disabled`, `tenant_disabled`, `channel_disabled`, `ai_paused`, `handed_off`, `inbox_other`, `contact_blocked`, `last_not_client`, `pending_outbound`, `no_config` y `tenant_suspended`, sin llamar al modelo                                                                                                                                                            |
| 3   | Puntaje             | OK: fórmula, extremos, sin requeridos, cambio de pesos y umbrales; guardado con desglose en la conversación y en `ai_runs`                                                                                                                                                                                                                                                      |
| 4   | `decide`            | OK: cada rama, incluido "reply y derivación → gana la derivación" y `hot_turns` también en `after_fields`                                                                                                                                                                                                                                                                       |
| 5   | `availability`      | OK: `immediate` deriva con el texto fijo; `after_fields` pregunta intro + `how_to_ask` y después deriva                                                                                                                                                                                                                                                                         |
| 6   | Respaldo en código  | OK: "¿lo tienen para retirar hoy?" deriva aunque el modelo no lo marque                                                                                                                                                                                                                                                                                                         |
| 7   | Calificación        | OK: reply por los controles, `ai:<id>`, `extracted_data` combinado sin borrar                                                                                                                                                                                                                                                                                                   |
| 8   | Derivación          | OK: `qualified` con el resumen completo, `hot_turns` y `max_turns`                                                                                                                                                                                                                                                                                                              |
| 9   | Después de derivar  | OK: sin corridas nuevas; texto fijo una sola vez, también fuera de horario                                                                                                                                                                                                                                                                                                      |
| 10  | Config inválida     | OK: DNI, tarjeta, CVV, CBU, contraseña, códigos, claves repetidas, pesos ≤ 0, `warm ≥ hot`, intro faltante; CUIT válido; config solo con guía válida                                                                                                                                                                                                                            |
| 11  | Controles de salida | OK: links/emails exactos, teléfonos, montos (también sin símbolo), datos sensibles, compromisos, negar ser asistente, fuga; deja pasar lo literal de la config                                                                                                                                                                                                                  |
| 12  | Evals               | Ver "Modelos". DeepSeek V4.1 Flash: 77/80 y todas las metas                                                                                                                                                                                                                                                                                                                     |
| 13  | Prueba real         | OK: horario, "¿sos un bot?", calificación (entendió 10x10 m = 100 m²), stock → deriva al instante (modelo y código), respuesta a mano → IA pausada. Corregido en el camino: un pedido fuera del rubro derivaba (`cannot_answer`) y una recomendación derivaba sin preguntar (`custom_recomendacion`). La derivación por calificación completa se probó en los tests, no en vivo |
| 14  | Logs y secretos     | OK: los tests buscan textos, respuestas, nombres y teléfonos en los logs; `git status` sin el archivo de secretos                                                                                                                                                                                                                                                               |

`npm run test`: 371/371 (con `dev:api` apagada: comparten la cola). `npm run lint` y `npm run typecheck`: OK.

### Modelos (evals con 76–80 casos)

| Modelo                                | Casos              | Costo por turno | Notas                                                            |
| ------------------------------------- | ------------------ | --------------- | ---------------------------------------------------------------- |
| **DeepSeek V4.1 Flash (por defecto)** | ~77/80             | USD 0,0009      | La conversación más natural y el mejor resumen                   |
| Claude Haiku 5.5                      | ~75/76             | USD 0,0011      | Cálido; a veces no aplica la guía. Sirve para clave propia (009) |
| GPT-6 Luna                            | ~75/76             | USD 0,0003      | El más barato; tono seco                                         |
| Gemini 3.8 Flash                      | 4/5 (prueba corta) | USD 0,0053      | Candidato, descartado por costo                                  |
| Claude Sonnet 5.5                     | —                  | USD 0,020       | Descartado por costo                                             |

Todos cumplen las metas: orden del puntaje 100 %, disparadores críticos 100 %, 0 datos inventados, 0 inyecciones, 0 pedidos sensibles, 0 % preguntas repetidas. Las pruebas costaron ~USD 2,40 en total (~USD 2 de la primera corrida con Sonnet).

### Tiempos de respuesta (prueba real)

Antes: ~25 s (10 s de debounce + ~1 s de cola + ~5 s del modelo + ~8 s de visto/escribiendo/envío). Ahora: "escribiendo…" desde los ~12 s y respuesta a los ~18–20 s: la IA marca visto y escribe mientras piensa, y el envío descuenta ese tiempo.

### Decisiones fuera de la tarea

#41 (política `app_select_active` para que los workers lean la empresa activa), #42 (errores de transporte sin derivar), #45 (`<datos_del_cliente>`), #46 (controles de salida y contexto literal), #47 (modelo por defecto), el `PresenceService` (visto + "escribiendo…" adelantado, con la misma pausa del canal ante 463/475) y la deuda de la 006 en `docs/decisiones.md`.
