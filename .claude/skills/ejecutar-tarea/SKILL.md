---
name: ejecutar-tarea
description: Flujo completo para ejecutar una tarea de docs/tareas/ - plan, implementación con tests, verificación, revisión por los dos subagentes revisores y cierre. Usar siempre que el usuario pida hacer, ejecutar o continuar una tarea.
---

# Ejecutar una tarea

Sos el **ejecutor**. Trabajás una sola tarea por sesión.

## 1. Preparar
1. Leé `CLAUDE.md` y `.claude/contexto/ESTADO.md`.
2. Leé la tarea completa. Si está en `docs/tareas/pendientes/`, movela a `docs/tareas/en-curso/` (con `git mv` si el archivo ya está en git).
3. Si la tarea referencia una spec en `docs/specs/`, leela también.
4. Si algo de la tarea es ambiguo o contradice `CLAUDE.md`, preguntá antes de seguir.

## 2. Planificar (esperar OK)
Mostrale al usuario un plan breve:
- Archivos a crear o modificar.
- Decisiones que no están en la tarea.
- Cómo vas a verificar cada criterio de aceptación.

**No escribas código hasta que el usuario apruebe el plan.**

## 3. Implementar
- Cambios chicos e incrementales. Respetá "Fuera de alcance".
- Lógica nueva: primero el test, confirmá que falla, después implementá.
- Seguí las reglas de `.claude/rules/` y los skills específicos (`migracion-db`, `webhook-whatsapp`, `cambio-prompt-ia`) cuando apliquen.
- No instales dependencias sin decir cuáles y por qué.

## 4. Verificar
- Corré la sección "Verificación" de la tarea completa, más tests, lint y typecheck si existen.
- Si algo falla, corregí y volvé a verificar. No avances con una verificación fallida.

## 5. Revisión (los otros dos agentes)
1. Lanzá **en paralelo** los subagentes `revisor-codigo` y `revisor-seguridad`, pasándoles la ruta del archivo de tarea y un resumen de qué cambiaste.
2. Corregí todo lo `BLOQUEANTE` (código) y todo lo `CRÍTICO`/`ALTO` (seguridad). Lo `IMPORTANTE`/`MEDIO`: corregilo o explicá por qué no.
3. Si hubo correcciones, volvé a verificar (paso 4) y relanzá **solo** el revisor que pidió cambios.
4. Máximo 3 rondas. Si después de 3 rondas sigue habiendo bloqueantes, frená y explicale al usuario qué queda pendiente.
5. Si un revisor marca algo que contradice la tarea o `CLAUDE.md`, no lo apliques: mencionáselo al usuario.

## 6. Cerrar
1. Mové la tarea a `docs/tareas/hechas/` y agregale al final una sección "Resultado" con: archivos tocados, resultado de la verificación, veredicto de cada revisor y decisiones tomadas.
2. Si tomaste una decisión de arquitectura o de producto, agregala a `docs/decisiones.md`.
3. Si te equivocaste en algo que podría repetirse, proponé (no apliques) una línea para `CLAUDE.md` o una regla.
4. Actualizá `.claude/contexto/ESTADO.md`: qué se hizo, qué sigue, bloqueos.
5. Proponé el mensaje de commit (en español, una línea de resumen + detalle). El commit lo confirma el usuario.

## Entregable al usuario
Resumen corto: qué se hizo, resultado de la verificación, veredicto de los dos revisores (y qué se corrigió por ellos), decisiones fuera de la tarea y el siguiente paso.
