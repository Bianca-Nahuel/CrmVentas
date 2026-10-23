---
name: nueva-tarea
description: Crea un archivo de tarea nuevo en docs/tareas/pendientes/ a partir de la plantilla. Usar cuando el usuario pida armar, escribir o planificar una tarea para el agente.
---

# Crear una tarea

1. Leé `docs/tareas/_plantilla.md` y `CLAUDE.md`.
2. Numerala con el siguiente número libre mirando `pendientes/`, `en-curso/` y `hechas/`: `NNN-nombre-corto.md` (ej. `002-migracion-inicial.md`).
3. Completá todas las secciones de la plantilla. Lo más importante:
   - **Criterios de aceptación verificables** (un humano o un comando puede decir sí/no).
   - **Verificación** con comandos concretos y el resultado esperado.
   - **Fuera de alcance** explícito, para que la tarea no crezca.
4. Una tarea = algo que se termina en una sesión. Si es más grande, dividila en varias y decí en qué orden van.
5. Si la tarea es una feature con reglas de negocio, creá o referenciá una spec en `docs/specs/`.
6. Si falta información para escribir los criterios, preguntá; no la inventes.
7. Mostrale la tarea al usuario para que la revise antes de darla por lista.
