# Decisiones del proyecto

Registro de decisiones de arquitectura y producto. La más nueva arriba. Cada una: qué se decidió, por qué y qué se descartó.

| # | Fecha | Decisión | Por qué | Descartado |
|---|---|---|---|---|
| 10 | 2026-10-23 | Los hooks y `permissions.deny` son red de seguridad, no la barrera única; el hook normaliza comillas, barras y `+` y bloquea `.env`, `docker compose config`, git destructivo, `rm -r` y SQL destructivo | El revisor de seguridad mostró evasiones simples del hook original; cualquier borrado recursivo lo ejecuta el usuario | Confiar solo en el hook |
| 9 | 2026-10-22 | IA vía OpenRouter, sin modelo propio | Pago por uso; un modelo en el VPS sería lento y de baja calidad, y uno con GPU cuesta cientos de USD/mes | Modelo local en VPS (CPU o GPU) |
| 8 | 2026-10-22 | WAHA como proveedor no oficial | Ya funcionando, un solo contenedor, varios motores, sin condiciones extra de licencia | Evolution API (más dependencias y condiciones de marca en la licencia) |
| 7 | 2026-10-20 | Doble proveedor de WhatsApp detrás de `WhatsAppProvider` (WAHA no oficial + Cloud API oficial con coexistencia) | Ofrecer las dos opciones al cliente sin duplicar la lógica | Elegir uno solo |
| 6 | 2026-10-20 | Todo lo específico de un negocio va en configuración (`tenant_configs`, base de conocimiento, catálogo importado) | Producto escalable a cualquier rubro de ventas | Lógica hardcodeada para un cliente |
| 5 | 2026-10-20 | La IA filtra leads (caliente / tibio / consulta simple / no es venta) y no responde a calientes ni cuando responde un humano | Ahorrar tiempo al vendedor sin pisarle las ventas | IA respondiendo todo |
| 4 | 2026-10-20 | Postgres 18 con RLS y dos usuarios (`ventas_owner` migraciones, `ventas_app` aplicación) | La RLS no se aplica al dueño de las tablas | Un solo usuario |
| 3 | 2026-10-20 | Entorno local con Docker Compose (Postgres + WAHA); backend y front en el host | Recarga rápida y entorno reproducible | Instalar Postgres en el sistema |
| 2 | 2026-10-20 | NestJS + Angular en monorepo, TypeScript en todo el stack | Mismo modelo mental en front y back, tipos compartidos | Spring Boot, Next.js full-stack |
| 1 | 2026-10-20 | Trabajo con un ejecutor y dos subagentes revisores (código y seguridad) | Que el trabajo no se califique a sí mismo | Revisión manual únicamente |

## Deuda de seguridad pendiente (hallazgos menores de la tarea 000)

Detectados por `revisor-seguridad`; no bloquean, quedan para una tarea de endurecimiento:

- Matcher de `PreToolUse` en `.claude/settings.json` es solo `Bash`: si hay herramienta PowerShell, el hook no corre ahí. Pasar a `Bash|PowerShell`.
- Lectura indirecta de secretos que hoy pasa: `grep -r PASSWORD infra` y `docker compose ... exec postgres env`.
- Faltan en `permissions.deny`: `Edit/Write(**/.env.development)`, `.env.test`, `.env.staging`.
- Evasiones deliberadas poco realistas: `.[e]nv`, `.{e,}nv`, `rm -f -r`, `git push -uf`, `DELETE FROM x` sin `;` y con argumentos después.
- Falsos positivos conocidos: `git rm -r --cached`, `grep ".*"` y `docker compose logs ... | grep config` quedan bloqueados.
