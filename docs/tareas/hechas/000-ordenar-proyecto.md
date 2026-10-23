# Tarea 000: ordenar el proyecto e instalar la configuración del agente

## Contexto
El repo ya tiene el entorno de desarrollo funcionando (tarea 001: `infra/`, `.env.example`,
`.gitignore`, `.gitattributes`, `docs/entorno-dev.md`). Ahora hay que dejar instalada la
configuración de trabajo con agentes: `CLAUDE.md`, reglas, skills, subagentes revisores, hooks y
la organización de tareas, a partir de los archivos del kit que se copiaron en `_kit/`.

## Objetivo
Que el repo quede con esta estructura, con todo commiteable y verificado:

```
CLAUDE.md
.claude/
  settings.json
  hooks/        guardia-bash.mjs, formatear.mjs
  rules/        base-de-datos.md, backend.md, whatsapp.md, ia.md, frontend.md
  skills/       ejecutar-tarea, nueva-tarea, migracion-db, webhook-whatsapp, cambio-prompt-ia
  agents/       revisor-codigo.md, revisor-seguridad.md
  contexto/     ESTADO.md
docs/
  entorno-dev.md            (ya existe, no se toca)
  decisiones.md
  specs/_plantilla.md
  tareas/_plantilla.md
  tareas/pendientes/
  tareas/en-curso/
  tareas/hechas/001-entorno-dev.md
evals/README.md
infra/                      (ya existe, no se toca)
```

## Antes de empezar
1. Mostrame `git status` y la estructura actual del repo (sin `node_modules`).
2. Si algún archivo de destino ya existe (por ejemplo un `CLAUDE.md` o `.claude/settings.json`), mostrame la diferencia y preguntame antes de reemplazarlo. Nunca pises `infra/`, `.env`, `.env.example`, `.gitignore` ni `docs/entorno-dev.md`.
3. Verificá que Node esté instalado (`node --version`): los hooks son scripts de Node. Si no está, avisame y frená.

## Pasos
1. Copiá los archivos de `_kit/` a la raíz respetando las rutas.
2. Mové el archivo de la tarea anterior (`setup-entorno-dev.md`, hoy en la raíz) a `docs/tareas/hechas/001-entorno-dev.md` y agregale al final una sección "Resultado" con el resumen de verificación que ya se hizo (9 puntos OK y las decisiones que se tomaron: dos archivos de Compose, variables de WAHA, usuario del dashboard, volumen de Postgres 18, `NOINHERIT`, `.gitattributes`).
3. Mové esta misma tarea a `docs/tareas/en-curso/` mientras trabajás y a `docs/tareas/hechas/` al terminar.
4. Agregá `.gitkeep` en las carpetas vacías (`docs/tareas/pendientes/`, `docs/tareas/en-curso/`).
5. Revisá `CLAUDE.md` contra la realidad del repo: si algún comando o ruta no coincide (por ejemplo el comando de Compose), corregilo y decime qué cambiaste.
6. Borrá `_kit/` al final (pedime permiso para borrar).

## Criterios de aceptación
- [x] La estructura coincide con la del Objetivo.
- [x] `infra/`, `.env`, `.env.example` y `docs/entorno-dev.md` sin cambios. `.gitignore` sí cambió (se agregó `.env.*` y `!.env.example`) con autorización del usuario tras la revisión de seguridad.
- [x] Los hooks funcionan (ver Verificación).
- [x] Los dos subagentes y los cinco skills aparecen disponibles.

## Verificación (obligatoria)
1. `git status` → muestra solo los archivos nuevos o movidos de esta tarea.
2. Hook `guardia-bash`: probalo pasándole por stdin un JSON `{"tool_input":{"command":"..."}}`:
   - `cat .env` → código de salida 2 (bloqueado)
   - `cat .env.example` → 0
   - `psql -c 'DROP TABLE x'` → 2
   - `git status` → 0
3. Hook `formatear`: pasale `{"tool_input":{"file_path":"CLAUDE.md"}}` → termina con 0 sin errores (todavía no hay Prettier, así que no debe hacer nada).
4. Confirmá que en este sistema operativo la variable `$CLAUDE_PROJECT_DIR` se expande en el comando del hook (en Windows los hooks corren con Git Bash). Si no se expande, cambiá el comando en `settings.json` a una ruta que funcione y decime cuál.
5. Listá los subagentes disponibles (`/agents`) y los skills del proyecto → aparecen `revisor-codigo`, `revisor-seguridad`, `ejecutar-tarea`, `nueva-tarea`, `migracion-db`, `webhook-whatsapp`, `cambio-prompt-ia`.
6. Prueba de punta a punta del flujo de revisión: lanzá los dos revisores en paralelo sobre esta misma tarea y mostrame sus veredictos.

## Fuera de alcance
- Crear el proyecto NestJS o Angular, `apps/` o `libs/`.
- Migraciones o tablas.
- Instalar dependencias de npm.
- Modificar el entorno de Docker.
- Hacer el commit (proponé el mensaje; lo confirmo yo).

## Entregable
Resumen: estructura final, archivos movidos, resultado de cada punto de la verificación, veredicto de los dos revisores, cambios hechos a `CLAUDE.md` o `settings.json` y mensaje de commit propuesto.

## Resultado
- Estructura instalada según el Objetivo; `infra/`, `.env.example` y `docs/entorno-dev.md` sin cambios. Tarea 001 movida a `hechas/`.
- Hooks verificados: `guardia-bash` (casos de la tarea más 32 propios) y `formatear` (exit 0); `$CLAUDE_PROJECT_DIR` se expande. El bloqueo de `cat .env` se probó en vivo en Claude Code.
- Subagentes y skills disponibles. `revisor-codigo`: aprobado. `revisor-seguridad`: aprobado tras endurecer `guardia-bash.mjs`, ampliar `permissions.deny` en `settings.json` y ajustar `.gitignore` (autorizado por el usuario).
- Hallazgos menores anotados en `docs/decisiones.md`. `CLAUDE.md` sin cambios (el comando de Compose era correcto).
- La carpeta del kit se llamaba `kit-agente/` (no `_kit/`). Su borrado queda a cargo del usuario porque el hook bloquea el borrado recursivo.
