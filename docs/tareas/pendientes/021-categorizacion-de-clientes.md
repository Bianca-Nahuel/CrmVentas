# Tarea 021: categorización de clientes (tipo, etapa, puntaje estable y próximo paso)

## Contexto

Puntos 25 a 30 y 32 del análisis del 2026-10-27 (decisión #63). Hoy el lead tiene solo un puntaje de 0 a
100 y caliente / tibio / frío. Faltan:

- **Qué es el contacto:** cliente final, profesional, posventa, proveedor, spam.
- **En qué etapa está.**

Además:

- El puntaje decide la derivación: un caliente se deriva sí o sí, mezclando "cuánto vale" con "cuándo
  pasarlo".
- El puntaje sube y baja por variaciones del modelo, porque se vuelve a puntuar todo en cada turno.
- La completitud solo cuenta los campos obligatorios.

El punto 31 (aprender de ganado / perdido) queda para después de la 014, que es la que permite marcarlos.

## Objetivo

Que la grilla del vendedor pueda filtrar y ordenar por tipo de contacto, etapa y puntaje, que el puntaje
sea estable y que la derivación tenga reglas propias.

## Antes de empezar

1. Leé `CLAUDE.md`, los skills `cambio-prompt-ia` y `migracion-db`, `scoring/score.ts`, `reply/decide.ts`,
   `libs/shared/src/ai/tenant-config.ts` y el schema de `conversations`.
2. Corré los evals y guardá la línea base.

## Pasos / requisitos

1. **Tipo de contacto:**
   - `scoring.contact_types: [{ key, description }]` en la config, con valores de fábrica que la empresa
     puede cambiar (cliente final, profesional/empresa, posventa/reclamo, proveedor, consulta suelta,
     spam);
   - el modelo lo clasifica en cada turno con su evidencia;
   - se guarda en `conversations.contact_type`;
   - la config puede decir qué tipos se derivan directo (por ejemplo posventa) y cuáles no se califican
     (proveedor, spam).
2. **Etapa:** `conversations.stage` con estos valores:
   - `nuevo`, `conversando`, `calificado`, `derivado`, `acompañante`: los calcula el código;
   - `en_negociacion`, `ganado`, `perdido`: los marca una persona en la 014; acá solo el valor y el
     check.
3. **Derivación separada del puntaje:**
   - `handoff.rules`: derivar por puntaje (umbral propio, que puede ser distinto del de "caliente"), por
     datos completos, por tipo de contacto o por disparador;
   - los valores por defecto reproducen el comportamiento de hoy.
4. **Puntaje estable:**
   - un turno no puede bajar el puntaje más de N puntos (constante) salvo con una señal explícita del
     cliente ("ya lo compré", "no me interesa");
   - pérdida con el tiempo: sin mensajes del cliente en X días, el puntaje que se muestra baja (calculado
     al leer, sin trabajos programados).
5. **Dimensiones:** el tope pasa de 8 a 12. La guía de la config sugiere sensibilidad al precio, si es quien
   decide la compra y si está comparando con la competencia.
6. **Completitud con pesos por campo** (`weight` opcional, 1 por defecto en los obligatorios y 0 en los
   opcionales), compatible con las configs actuales.
7. **Próximo paso:** el modelo propone `next_step` (hasta 200 caracteres) para el vendedor; se guarda con
   el resumen de derivación.
8. Migración con su RLS y sus grants por columna; índices para filtrar por `stage` y `contact_type`.

## Criterios de aceptación

- [ ] Los evals clasifican el tipo de contacto en los dos rubros (≥ 85 % de aciertos en los casos con tipo
      esperado).
- [ ] Con la config por defecto, `decide()` da las mismas decisiones que hoy (tests de regresión); con
      `handoff.rules` cambiadas, la derivación sigue la regla nueva.
- [ ] El puntaje no baja más de N en un turno sin una señal explícita (test de `score`).
- [ ] La etapa se calcula bien en cada transición del código (tests).
- [ ] Las configs viejas validan sin cambios.

## Verificación (obligatoria)

1. `npm run lint && npm run typecheck` → sin errores.
2. `npm run db:migrate` y `npm run test` → verde.
3. `npm run evals -- --max-usd 0.30` → tabla de tipo de contacto, puntaje y derivaciones.

## Fuera de alcance

- La grilla y los filtros en el panel (014).
- Ajustar los pesos con datos de ganado / perdido (después de la 014).

## Entregable

Resumen con:

- los archivos tocados;
- el resultado de la verificación;
- el veredicto de `revisor-codigo` y de `revisor-seguridad`;
- las decisiones tomadas.
