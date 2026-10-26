# Tarea 008: créditos mensuales y control de gasto de la IA

## Contexto

La 006 dejó la IA respondiendo con OpenRouter y la clave de la plataforma, y cada corrida registrada en
`ai_runs` con su costo. Además, el `AiBudgetGuard` (`reserve` / `settle` / `release`) que se llama antes y
después de cada llamada al modelo, que por ahora no bloquea nada.

El sistema es híbrido:

- **Modo `platform`:** la empresa usa nuestra clave de OpenRouter. Nosotros pagamos y le asignamos
  **créditos mensuales**. Esta tarea.
- **Modo `byok`:** la empresa usa su propia clave de Anthropic u OpenAI. Paga su proveedor y nosotros
  solo le mostramos cuánto lleva gastado. Tarea 009.

Esta tarea implementa los créditos, los límites que nos protegen como plataforma y el reporte de consumo,
que sirve para los dos modos.

## Objetivo

- Una empresa en modo `platform` nunca puede gastar más créditos de los que tiene, ni siquiera con
  corridas en paralelo.
- Ninguna empresa puede asignarse créditos a sí misma.
- Un tope diario global protege a la plataforma ante un bug o un abuso.
- Reporte de consumo por empresa y mes: créditos, costo real en USD, por proveedor y por modelo.

## Decisiones de negocio (valores por defecto, configurables)

Dejalas como constantes o columnas de la configuración de facturación, documentadas en `docs/decisiones.md`:

| Decisión                          | Por defecto                                                         |
| --------------------------------- | ------------------------------------------------------------------- |
| Valor de 1 crédito                | USD 0,001 de costo del modelo                                       |
| Margen sobre el costo             | ×1,5 (1 USD de costo consume 1.500 créditos)                        |
| Créditos que no se usan en el mes | Se pierden, no se acumulan                                          |
| Al llegar al 100 %                | Límite duro: la IA deja de responder y todo se deriva a una persona |
| Aviso                             | Al 80 % y al 100 %                                                  |
| Período                           | Mes calendario en la zona horaria de la empresa                     |

## Antes de empezar

1. Leé `CLAUDE.md`, el skill `ejecutar-tarea`, el skill `migracion-db`, el `AiBudgetGuard` y el
   `LlmClientFactory` de la 006, y cómo se programan trabajos recurrentes en pg-boss (documentación actual).

## Pasos / requisitos

### 1. Configuración de facturación por empresa (`tenant_ai_billing`)

- `tenant_id` (PK), `billing_mode` (`platform` | `byok`), `monthly_credits`, `markup`,
  `alert_threshold_pct`, `hard_limit` (bool), `updated_by`, timestamps.
- **`ventas_app` solo tiene `SELECT`.** Esta tabla la cambia únicamente un administrador de la plataforma.
  Proponé el mecanismo: una función `SECURITY DEFINER` que verifique el rol de administrador de la
  plataforma, o un script de administración. Justificá cuál y cómo se usaría en producción.
- Una empresa sin fila se trata como `platform` con 0 créditos: la IA no corre. Nunca "ilimitado por defecto".

### 2. Libro de créditos (`ai_credit_ledger`), solo de agregado

- Columnas: `tenant_id`, `period` (primer día del mes), `kind` (`grant`, `reserve`, `settle`, `release`,
  `adjust`), `credits numeric(14,4)` con signo, `usd_cost numeric(12,6)`, `reservation_id`, `ai_run_id`,
  `created_by`, `note`, `created_at`.
- **Sin `UPDATE` ni `DELETE` para nadie de la app.** El saldo se calcula sumando.
- `ventas_app` puede insertar **solo** `reserve`, `settle` y `release`. `grant` y `adjust` van por el mismo
  mecanismo de administración del punto 1. Si no se puede restringir por columna con grants, hacelo con
  una política de RLS para `INSERT` y explicá por qué alcanza.
- UNIQUE para que el `grant` mensual no se duplique: `(tenant_id, period) WHERE kind = 'grant'`.
- Si sumar todo el libro en cada llamada es lento, proponé una tabla de saldos por período mantenida en la
  misma transacción, pero el libro sigue siendo la fuente de verdad.

### 3. `AiBudgetGuard` real (modo `platform`)

- `reserve`:
  - toma un lock por empresa (`pg_advisory_xact_lock`);
  - calcula saldo = asignado + ajustes − consumido − reservado sin cerrar;
  - si alcanza para la estimación × margen, inserta la `reserve`; si no, rechaza.
- `settle`: libera la reserva y registra el consumo real (`usd_cost` × margen convertido a créditos),
  enlazado al `ai_run`.
- `release`: si la llamada falló sin costo.
- Reservas huérfanas (el proceso se cayó en el medio) → un trabajo periódico las libera pasado un tiempo
  (constante), registrando un `release`.
- Si el costo real supera la reserva, se registra igual: el saldo puede quedar levemente negativo, y la
  próxima `reserve` rechaza.
- En modo `byok` no consume créditos: en esta tarea no bloquea. La 009 agrega el presupuesto opcional.

### 4. Qué pasa cuando no alcanza

- No se llama al modelo. `ai_runs` queda con la decisión `skipped:no_credits` y la conversación se deriva
  a una persona, igual que un caliente.
- Al cruzar el 80 % y el 100 %, se registra un aviso **una sola vez por período** (tabla
  `ai_billing_alerts`) y una línea de log de nivel `warn`, sin datos personales. El envío por email o al
  panel va en una tarea posterior.

### 5. Tope global de la plataforma

- `AI_PLATFORM_DAILY_USD_CAP` en el entorno: suma del costo real de **todas** las empresas en modo
  `platform` en el día (UTC). Si se supera, se corta la IA de todas en ese modo hasta el día siguiente,
  con log `error`.
- Se chequea en `reserve`, sin depender de que cada empresa tenga créditos.
- Documentá además, en `docs/entorno-dev.md`, que hay que configurar un **límite de gasto en la clave de
  OpenRouter** como última barrera, fuera de nuestro código.

### 6. Asignación mensual

- Trabajo programado (pg-boss) que el primer día de cada mes, en la zona horaria de cada empresa, inserta
  el `grant` de `monthly_credits`. Es idempotente por el UNIQUE.
- Si una empresa cambia de plan a mitad de mes, la diferencia va como `adjust` con nota.

### 7. Scripts de administración (solo fuera de `production` en esta tarea)

- `npm run admin:billing -- --tenant <id> --mode platform --credits 50000`
- `npm run admin:credits -- --tenant <id> --adjust 10000 --note "compra extra"`
- `npm run ai:usage -- --tenant <id> --month 2026-11`, que imprime:
  - créditos asignados, usados, reservados y saldo;
  - costo real en USD y créditos cobrados (para ver nuestro margen);
  - corridas y costo por proveedor y por modelo;
  - para modo `byok`, el costo **estimado** desde `ai_runs` (`cost_source`).
- La consulta del reporte queda en un servicio reutilizable, para que el panel la use después.

## Criterios de aceptación

- [ ] Con corridas en paralelo, el consumo nunca supera el saldo más una sola corrida.
- [ ] Una empresa no puede insertar `grant` ni `adjust`, ni modificar su configuración de facturación.
- [ ] Sin créditos o con el tope global superado, no se llama al modelo y la conversación se deriva.
- [ ] El `grant` mensual no se duplica.
- [ ] `npm run test`, `npm run lint` y `npm run typecheck` pasan.

## Verificación (obligatoria)

1. Saldo de 100 créditos y estimación de 60: la primera `reserve` pasa, la segunda en paralelo se rechaza.
2. 20 corridas en paralelo con saldo para 5 → como máximo 5 llaman al modelo (con el `LlmClient` falso).
3. `settle` con costo menor que lo reservado → el saldo refleja el real; con costo mayor → saldo negativo
   y la siguiente `reserve` se rechaza.
4. Reserva huérfana → el trabajo periódico la libera.
5. Sin créditos → `skipped:no_credits`, sin llamada al modelo y conversación derivada.
6. Empresa sin fila de facturación → la IA no corre.
7. Avisos del 80 % y del 100 %: una sola vez por período.
8. Tope global: superado → ninguna empresa `platform` llama al modelo; al día siguiente vuelve.
9. Como `ventas_app` en la empresa A: `INSERT` de un `grant` → falla; `UPDATE` de `tenant_ai_billing` →
   falla; `UPDATE` o `DELETE` en el libro → `permission denied`.
10. Aislamiento: la empresa A no ve el libro ni el saldo de la B.
11. Asignación mensual corrida dos veces → un solo `grant`.
12. `ai:usage` con datos de prueba → totales correctos por proveedor y por modelo, y margen.
13. Logs sin datos personales.
14. `git status`: sin `.env`.

## Fuera de alcance

- Claves propias y presupuesto en modo `byok`: tarea 009.
- Cobro a las empresas (pasarela de pago, facturas).
- Pantallas de consumo y de compra de créditos.
- Avisos por email.

## Entregable

Resumen: archivos creados, mecanismo de administración elegido y su porqué, valores por defecto, resultado
de cada punto de la verificación, veredicto de `revisor-codigo` y `revisor-seguridad`, decisiones nuevas
en `docs/decisiones.md` y mensaje de commit propuesto.
