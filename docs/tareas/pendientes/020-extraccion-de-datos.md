# Tarea 020: mejor extracción de datos (tipos flexibles, deducciones y correcciones)

## Contexto

Puntos 18, 19, 21 y 24 del análisis del 2026-10-27 (decisión #63). Los puntos 17 y 20 van en la 010.

- **Tipos rígidos:** `m2` es un número, así que "entre 30 y 40" o "un baño de 2x3" quedan en `null` y se
  repregunta. Lo mismo pasa con una fecha como "cuando termine la obra" o "en un par de semanas".
- Solo se guarda lo explícito: lo obvio ("soy arquitecto" → profesional) no queda registrado.
- **Lo descubierto es texto libre:** los temas se duplican y no se pueden filtrar.
- El cliente no puede corregir un dato de forma explícita.

## Objetivo

- Que todo lo que el cliente dice de un dato quede guardado, aunque no sea exacto.
- Distinguir lo dicho de lo deducido.
- Que la empresa defina los temas de descubrimiento.

## Antes de empezar

1. Leé `CLAUDE.md`, los skills `cambio-prompt-ia` y `migracion-db`, `libs/shared/src/ai/tenant-config.ts`,
   `prompts/v*/output-schema.ts`, `reply-engine.ts` (`mergeExtracted`, `mergeDiscovered`) y
   `scoring/score.ts`.
2. Corré los evals y guardá la línea base.

## Pasos / requisitos

1. **Valor dicho y valor normalizado:** cada campo extraído pasa a ser
   `{ valor, dicho, confianza: 'dicho' | 'deducido', cita }`:
   - `dicho` es el texto tal cual lo dijo el cliente;
   - `valor` es el normalizado, o `null` si no se puede normalizar.

   Ejemplos:
   - "2x3" → valor 6, dicho "un baño de 2x3", y el modelo puede calcular largo × ancho;
   - "entre 30 y 40" → valor 35 (o un rango `{min, max}` para los campos `number`);
   - "cuando termine la obra" → valor `null`, dicho guardado.

   Un campo con `dicho` y sin `valor` **cuenta como respondido** para `faltan` y no se repregunta.

2. **Tipo nuevo `urgency`** (`esta_semana`, `este_mes`, `mas_adelante`, `sin_fecha`) para las empresas que
   lo prefieran a una fecha. Cuando no hay una fecha exacta, `date` admite una aproximación.
3. **Deducidos:**
   - `confianza: 'deducido'` solo con una cita que lo justifique;
   - no completa los campos obligatorios para derivar, salvo que la config lo permita
     (`accept_inferred: true` por campo);
   - se muestra distinto en el resumen.
4. **Temas de descubrimiento configurables:**
   - `qualification.discovery_topics: [{ key, label, type, options? }]` en la config;
   - `discovered` usa esas claves;
   - si un tema no está en la lista, va a `otros` con texto libre.
5. **Correcciones:** si el cliente corrige un dato ("no, eran 60"), se reemplaza y queda el historial del
   cambio en `ai_runs`. Un `null` sigue sin borrar un dato.
6. Migración del `extracted_data` existente (si hace falta), compatible con las conversaciones abiertas.
7. Fixtures de la config y evals de los dos rubros actualizados.

## Criterios de aceptación

- [ ] "Un baño de 2x3", "entre 30 y 40" y "para fin de mes" quedan guardados y no se repreguntan (evals).
- [ ] Un deducido sin cita no se guarda; un deducido no completa un obligatorio salvo con
      `accept_inferred` (tests).
- [ ] `discovered` usa las claves de la config (tests de schema y evals).
- [ ] Una corrección reemplaza el valor (eval).
- [ ] Evals sin regresión en el puntaje y los disparadores.

## Verificación (obligatoria)

1. `npm run lint && npm run typecheck` → sin errores.
2. `npm run db:migrate` y `npm run test` → verde.
3. `npm run evals -- --max-usd 0.30`, antes y después → tabla de extracción por campo.

## Fuera de alcance

- La categorización del contacto (021).
- Mostrar los datos en el panel.

## Entregable

Resumen con:

- los archivos tocados;
- el resultado de la verificación y la tabla de evals;
- el veredicto de `revisor-codigo` y de `revisor-seguridad`;
- las decisiones tomadas.
