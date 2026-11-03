# Tarea 028: embudo de ventas

> **Depende de la tarea de revisión de vendedores** (cierre con resultado, `conversation_metrics`, función de
> tiempo en horario de atención y librería de gráficos). Si esa tarea no está mergeada, frená y avisame.

## Contexto
El embudo responde una pregunta sobre el **cliente**: *de toda la gente que escribe, ¿cuántos terminan
comprando y en qué paso se pierden?* No evalúa al equipo (eso es Rendimiento): muestra el recorrido de los
leads para ajustar el negocio, el agente y la oferta.

Las etapas **salen solas de los datos que ya existen** (puntaje, derivación, respuestas humanas, cierre con
resultado). En esta tarea no hay etapas manuales ni tablero kanban.

Referencias: `CLAUDE.md`, `.claude/rules/*`, skill `angular-developer`, `docs/decisiones.md` (visibilidad por
número, atribución de vendedores, definición de las métricas de Rendimiento), `conversation_metrics` y el
helper `ConversationScope`.

## Objetivo
- Embudo por cohorte (las conversaciones que **empezaron** en el período), con conteos, conversión entre
  etapas, tiempos entre etapas y motivos de pérdida.
- Filtros por período, número, nivel y vendedor (cuando se pueda atribuir).
- Desde cada etapa, la lista de leads que están ahí o que se cayeron ahí.
- Una pantalla clara en celular y escritorio.

## Antes de empezar
1. Leé `CLAUDE.md`, las reglas, el skill `angular-developer` y las decisiones de la tarea de revisión de
   vendedores (métricas, atribución, horario de atención).
2. Confirmá que estén disponibles: `close_outcome`, `conversation_metrics`, la función de horario de atención
   y la librería de gráficos elegida.

## Etapas (definición exacta)
Cada conversación se cuenta **una sola vez**, en la cohorte de la semana o del período en que entró
(`first_inbound_at`, en la zona horaria de la empresa). Cada etapa es "**la alcanzó alguna vez**":

| # | Etapa | Se alcanza cuando |
|---|---|---|
| 1 | **Escribió** | Hay una conversación nueva con al menos un mensaje del cliente |
| 2 | **Calificado** | Su nivel máximo alcanzado fue tibio o caliente |
| 3 | **Caliente** | Su nivel máximo alcanzado fue caliente |
| 4 | **Derivado** | Se derivó a una persona al menos una vez (aunque después se haya reactivado la IA) |
| 5 | **Atendido** | Respondió una persona del equipo al menos una vez |
| 6 | **Vendido** | Se cerró con `close_outcome = 'sold'` |

Además, como salida de la etapa:
- **No vendido:** cerrada con `not_sold`, `no_response` u `other`;
- **No era un lead:** `not_a_lead`, que se muestra aparte y se puede excluir con un filtro;
- **En curso:** todavía abierta;
- **Cerrada por inactividad:** `auto_inactive`.

Datos que hacen falta (migración y relleno):
- **`conversations.lead_tier_peak`:** nivel máximo alcanzado, **guardado en el momento** con los umbrales
  vigentes (si la empresa cambia los umbrales, no se recalculan las conversaciones viejas). Lo actualiza el
  worker del agente; nunca baja. Grant de `UPDATE` solo de esa columna.
- **`conversation_metrics.first_handed_off_at`:** la primera derivación, que **no** se borra al reactivar
  (hoy `conversations.handed_off_at` vuelve a `NULL`). Si ya existe un dato equivalente, reutilizalo.
- Script `npm run dev:backfill-funnel` que completa estos datos desde `ai_runs` y `conversation_events`.

**El embudo no es estrictamente lineal.** Por ejemplo, un vendedor puede responder sin que haya derivación,
o una conversación puede venderse sin haber pasado por "caliente". Por eso:
- la **conversión** de la etapa *k* a la *k+1* = conversaciones que alcanzaron **las dos** / las que alcanzaron la *k*;
- los **atajos** se muestran aparte: atendidos sin derivación, vendidos sin pasar por caliente y vendidos
  sin atención humana (resueltos solo por la IA).

## Pasos / requisitos

### 1. Monto de la venta (opcional al cerrar)
- En el diálogo de cierre, si el resultado es "vendido", un campo **opcional** "Monto aproximado (ARS)".
- `conversations.close_amount numeric(14,2)`, con CHECK > 0 y grant de `UPDATE` de esa columna.
- El embudo muestra el total y el promedio por venta **solo** sobre las ventas que lo tienen, aclarando
  cuántas lo tienen ("monto cargado en 9 de 15 ventas").

### 2. API
Permiso `metrics: ['read']` (`owner`, `admin` y `viewer`). Siempre con `ConversationScope`: si en algún momento
un rol con visibilidad limitada tiene este permiso, ve solo sus números.
- **`GET /api/funnel?from=&to=&groupBy=total|week&channelId=&userId=&excludeNotALead=`:**
  - conteo por etapa, conversión entre etapas y atajos;
  - salidas (no vendido por motivo, no era un lead, en curso, inactividad);
  - **tiempos** (mediana y p90, en horario de atención): escribió → derivado, derivado → atendido y
    escribió → vendido;
  - con `groupBy=week`, lo mismo por cohorte semanal (como mucho 26 semanas), para ver la tendencia de la conversión;
  - montos (paso 1);
  - `userId` solo con conversaciones atribuibles, con la misma regla y el mismo aviso que en Rendimiento.
- **`GET /api/funnel/leads?stage=&outcome=&from=&to=&channelId=&page=`:** las conversaciones de una etapa, o
  las que **se cayeron** en ella (`dropped=true`: alcanzaron la etapa pero no la siguiente y ya están
  cerradas), con las mismas columnas que la grilla de leads. Así, desde el embudo se llega al caso concreto.
- **`GET /api/funnel/stalled?days=`:** **estancados**, es decir, conversaciones abiertas, con nivel máximo
  caliente y sin mensajes en N días (por defecto 3), ordenadas por puntaje. Es la lista de "oportunidades que
  se están enfriando".
- Mostrame en el plan el SQL o el `EXPLAIN` de la consulta principal, con los índices.

### 3. Pantalla (ruta `/embudo`, entrada "Embudo" en el menú con el permiso `metrics:read`)
- **Filtros:** período (esta semana, últimas 4 semanas, últimos 3 meses o un rango), número, vendedor,
  y excluir "no era un lead". Se guardan en la URL.
- **Embudo:** barras horizontales, una por etapa, con la cantidad y el porcentaje sobre "escribió" y, entre
  cada barra, la conversión y **cuántos se perdieron**. Accesible: también como tabla, y sin depender
  solo del color.
- **Clic en una etapa o en una pérdida** → lista de esos leads (los mismos componentes que la grilla), con
  enlace a la conversación.
- **Por qué se pierden:** motivos de cierre de los que no compraron (en especial de los calientes), y la
  cantidad de derivados que nadie atendió, con enlace a Rendimiento.
- **Tiempos entre etapas** (mediana y p90, en horario de atención).
- **Tendencia:** conversión de "escribió → vendido" y de "caliente → vendido" por cohorte semanal.
- **Atajos:** las tres cifras del paso de etapas, con una explicación corta.
- **Estancados:** tarjeta con la cantidad y la lista.
- **Montos:** total y promedio por venta, con la aclaración de cuántas ventas lo tienen cargado.
- **Celular:** las barras pasan a lista vertical con el número y el porcentaje; los gráficos de tendencia,
  a una tabla corta.
- **Aviso** cuando hay pocas conversaciones en el período ("menos de 30 conversaciones: los porcentajes
  pueden variar mucho").

## Criterios de aceptación
- [ ] Cada etapa se calcula con la definición exacta de esta tarea, sobre la cohorte del período.
- [ ] Reactivar la IA no borra la derivación del embudo, y cambiar los umbrales no recalcula conversaciones viejas.
- [ ] Desde cualquier etapa o pérdida se llega a la lista de leads y a la conversación.
- [ ] La visibilidad por número y la atribución de vendedores se respetan igual que en Rendimiento.
- [ ] `npm run test`, `npm run lint`, `npm run typecheck`, `npm run build` y `npm run e2e:web` pasan.

## Verificación (obligatoria)
1. **Seed de varias semanas** con conversaciones que recorren cada camino: se caen en cada etapa, se venden
   por el camino completo, se venden sin caliente, las atiende una persona sin derivación, se resuelven
   solo con la IA, se derivan y se reactivan, no eran un lead, quedan en curso o se cierran por inactividad.
   Los conteos, la conversión y los atajos coinciden con lo esperado, calculado a mano en el test.
2. **Reactivación:** derivar → reactivar → la conversación sigue contando como derivada.
3. **Umbrales:** subir el umbral de caliente → las conversaciones viejas mantienen su `lead_tier_peak`.
4. **Cohortes:** una conversación que empezó el domingo a las 23:30 (hora de la empresa) cae en la semana correcta.
5. **Tiempos:** coinciden con la función de horario de atención en casos de borde.
6. **Montos:** total y promedio solo con las ventas que lo tienen, con el conteo correcto.
7. **Listas:** `funnel/leads` con `stage` y con `dropped=true` devuelve exactamente las conversaciones
   esperadas; `stalled` respeta los días y el orden.
8. **Permisos y aislamiento:** `seller` sin `metrics:read` → 403; `viewer` → ve el embudo; la empresa A no ve
   nada de la B; la visibilidad por número se aplica.
9. **Backfill:** sobre conversaciones existentes, completa `lead_tier_peak` y `first_handed_off_at` sin duplicar.
10. **Panel:** Playwright de los filtros, el clic en una etapa y el enlace a la conversación. Capturas en
    claro y oscuro, a 375 y 1280 px. **Mostrámelas antes de cerrar.**
11. Logs sin datos personales. `git status` sin `.env`.

## Fuera de alcance
- Etapas manuales o tablero kanban (por ejemplo "presupuesto enviado").
- Atribución a campañas o anuncios (requiere la conexión oficial).
- Exportar el embudo.
- Proyecciones o metas de venta.

## Entregable
Resumen: migraciones y backfill, definición final de cada etapa, SQL principal con su `EXPLAIN`, resultado de
cada punto de la verificación con las capturas, veredicto de `revisor-codigo` y `revisor-seguridad`,
decisiones nuevas en `docs/decisiones.md` y mensaje de commit propuesto.

## Resultado

_Hecha el 2026-11-03 en la rama `claude/gallant-allen-l45xxr`. La 026 estaba mergeada en `main` (`0f74298`)._

### Qué se hizo
- **Migraciones:**
  - `0030_embudo_de_ventas` agrega `conversations.lead_tier_peak` y `conversations.close_amount numeric(14,2)` (CHECK: NULL, o mayor que 0 y `close_outcome = 'sold'`). En `conversation_metrics` agrega `handoff_seconds_business`, `sold_seconds_business` y `close_amount`. Suma los índices `conversation_metrics_first_inbound_idx` y `conversations_stalled_idx`.
  - `0031_embudo_de_ventas_rls` da grants de UPDATE solo de esas columnas.
  - **No se creó `first_handed_off_at`:** se reusa `conversation_metrics.handed_off_at`, que ya era la primera derivación y no se borra al reactivar.
- **Datos:**
  - El worker de la IA guarda `lead_tier_peak` con los umbrales vigentes y solo lo hace subir.
  - `refreshConversationMetrics` copia el nivel máximo (ya no lo recalcula con los umbrales de hoy), calcula los dos tiempos y copia el monto.
  - El cierre acepta `amount` opcional, solo con "vendido".
  - Backfill: `npm run dev:backfill-funnel` (`src/funnel/funnel-backfill.ts`).
- **API (`src/funnel/`):**
  - `GET /api/funnel` pide `metrics.read`.
  - `GET /api/funnel/leads` y `GET /api/funnel/stalled` piden además `lead.read`.
  - Las definiciones de las etapas viven en un solo lugar (`funnel-sql.ts`).
  - `InboxService.leadRowsWhere` comparte las filas con la grilla.
- **Panel:**
  - `/embudo` reemplaza al lugar reservado "Métricas" (`/metricas` redirige).
  - Tiene barras con su tabla, listas por etapa, pérdida o salida, por qué se pierden, tiempos, atajos, tendencia (tabla corta en el celular), estancados y montos, más el aviso de pocas conversaciones.
  - `LeadTable` se sacó de la grilla de leads y se comparte con el embudo.
  - El diálogo de cierre tiene el monto en formato argentino.
- **Seed:** seis semanas con todos los caminos.

### Verificación
1. **Etapas:** el test `test/funnel.test.ts` (18 casos) tiene una cohorte de 15 conversaciones con cada camino; los conteos, la conversión, las pérdidas, los atajos y las salidas están calculados a mano. Para confirmar que los tests no pasan de vacío, se rompió a propósito una expectativa y el test falló.
2. **Reactivación** con la API: la conversación sigue contando como derivada.
3. **Umbrales**, pasando por el worker real con el modelo falso: con puntaje 80 queda caliente; al subir el umbral a 95, `lead_tier` pasa a tibio y `lead_tier_peak` sigue caliente, también en las métricas.
4. **Cohortes:** la conversación del domingo 23:30 cae en su semana; se respetan los topes de 26 semanas y de 366 días.
5. **Tiempos:** coinciden con `businessSecondsBetween`, incluido el fin de semana.
6. **Montos:** total, promedio y conteo correctos; la validación funciona y el CHECK de la base también.
7. **Listas** por etapa, pérdida y salida, con paginación; `stalled` respeta los días y el orden.
8. **Permisos y aislamiento:** seller → 403; el viewer ve el embudo, pero las listas le dan 403; la empresa B no ve nada de A; un rol con visibilidad por número ve solo sus números.
9. **Backfill:** completa con los umbrales de cada versión, después con `lead_tier` y, si no hay nada, con `lead_score_peak`; no duplica. En la base local, la primera corrida completó 24 y la segunda, 0.
10. **Panel:** `e2e/funnel.spec.ts` (5 tests) y capturas `37` a `41` en claro y oscuro, a 375 y 1280 px.
11. **Logs y secretos:** logs sin textos ni teléfonos; ningún secreto en el repo.

**Totales:**
- **Tests:** API 788/789 (la falla es la de `catalog-db.test.ts:392`, previa); `waha-inbound` falló una vez a nivel de archivo y pasó en las dos corridas siguientes (intermitente); panel 117/117; e2e 46/46.
- **Lint:** OK.
- **Typecheck:** OK salvo `test/inbox-reply.test.ts:317`, que es previo.
- **Build:** OK; el bundle inicial pasó de 515,76 kB a 517,96 kB.

**Otros ajustes:**
- **e2e previo:** se ajustó una expectativa de `e2e/inbox.spec.ts` que ya fallaba en `main`, porque el texto de la página había cambiado.

**EXPLAIN** (30.000 conversaciones sintéticas, como `ventas_app` con la RLS activa):
- La consulta principal hace un `Bitmap Index Scan` sobre `conversation_metrics_first_inbound_idx`, con la empresa y el rango como condición del índice.
- La RLS se evalúa una sola vez (`InitPlan`).
- 4 a 5 ms para 4 semanas y 12 a 18 ms para 3 meses, con `groupBy=week`.

**Entorno:** este contenedor no tiene Docker y la red bloquea `postgresql.org`. Se usó PostgreSQL 18.6 de `@embedded-postgres/linux-x64`, instalado fuera del repo, en una base local creada como en `infra/postgres/init`.

### Revisores
- **`revisor-codigo`: APROBADO**, sin bloqueantes. Menores:
  - (a) "Se perdieron" excluye las vendidas por un atajo: está documentado en la decisión #118 y queda así.
  - (b) El período se calcula con la fecha del navegador y no con la zona de la empresa: queda como deuda.
  - (c) Antes de producción hay que rellenar `lead_tier_peak`: el backfill de hoy es solo para desarrollo. Queda como deuda.
  - (d) Hay helpers de fechas duplicados: queda.
  - (e) Faltaba un test del cálculo de la tendencia: **corregido**, con `trendPoints` y su test.
- **`revisor-seguridad`: APROBADO**, sin hallazgos críticos, altos ni medios. Uno bajo: una config local de Playwright para el Chromium del contenedor. **Corregido:** se borró y nunca se commiteó.

### Decisiones
#118 a #122 en `docs/decisiones.md`: definiciones, datos congelados, permisos, monto y backfill.

### Deuda
- **Producción:** rellenar `lead_tier_peak` y la primera derivación de las conversaciones existentes, que hoy se hace con un script solo de desarrollo. Hasta entonces, el nivel de Rendimiento de esas conversaciones queda en NULL después de un refresh.
- **Período del panel:** calcularlo con el "hoy" de la empresa.
