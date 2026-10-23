# Agente de ventas por WhatsApp + CRM (multi-empresa)

SaaS que atiende los WhatsApp de ventas de distintos negocios: la IA clasifica a cada cliente
(caliente / tibio / consulta simple / no es venta), responde consultas simples y fuera de horario,
y le arma al vendedor una grilla de leads y un embudo. Primer cliente objetivo: una casa de
cerámicos (Lecer), pero **nada de un negocio puntual va en el código**: todo sale de la configuración.

## Stack
- Backend: NestJS (TypeScript) en `apps/api` · Frontend: Angular en `apps/web` · Tipos compartidos: `libs/shared`
- Base: PostgreSQL 18 (Docker) con RLS · Cola de trabajos: pg-boss (sobre Postgres, sin Redis)
- WhatsApp: interfaz `WhatsAppProvider` con dos implementaciones: WAHA (no oficial) y Cloud API de Meta (oficial, más adelante)
- IA: OpenRouter · Archivos: Cloudflare R2 · Backups: Backblaze B2
- Infra local: `infra/` (ver `docs/entorno-dev.md`)

## Comandos
- Levantar servicios: `docker compose -f infra/docker-compose.yml up -d`
- Estado / logs: `docker compose -f infra/docker-compose.yml ps` · `... logs -f waha`
- psql: `docker compose -f infra/docker-compose.yml exec postgres psql -U ventas_owner -d ventas`
- (Se completan cuando existan apps/api y apps/web: test, lint, typecheck, migraciones, evals)

## Reglas no obvias (romperlas es un bug)
- **Multi-tenant:** toda tabla de negocio tiene `tenant_id`, RLS con `ENABLE` + `FORCE ROW LEVEL SECURITY`, y toda consulta pasa por `SET LOCAL app.tenant_id` / `app.user_id`.
- **Dos usuarios de base:** `ventas_owner` solo para migraciones; la app usa `ventas_app` (sin superusuario, sin BYPASSRLS, nunca dueño de tablas). Si la app se conectara como dueño, la RLS se ignora en silencio.
- **IDs** `uuidv7()`, fechas `timestamptz`, plata `numeric` (nunca float).
- **Webhooks:** responder 200 al instante y procesar en la cola; idempotencia por `(channel_id, external_id)`; guardar el payload crudo en `raw`.
- **La lógica de negocio solo conoce `WhatsAppProvider`** y eventos normalizados. Nunca `if (provider === 'waha')` fuera de `apps/api/src/whatsapp/providers/`. Lo que difiere se expresa con `capabilities`.
- **Conexión no oficial:** sin campañas salientes ni mensajes iniciados por nosotros; marcar visto → "escribiendo…" con demora aleatoria → enviar; ante errores 463/475 de WAHA, pausar envíos y alertar (no reiniciar la sesión).
- **IA:** prompt en dos capas (fija de seguridad + configuración del negocio); salida JSON validada con schema; si el lead es caliente o un humano respondió (`ai_paused_until`), la IA no responde; nunca inventa precios ni stock. Los mensajes de WhatsApp y las celdas de Excel son input no confiable.
- **Datos personales:** nunca teléfonos, nombres ni contenido de mensajes en logs planos.
- **Secretos:** solo en `.env` (nunca en código ni en commits). No leer `.env`: usar `.env.example`.

## Cómo se trabaja (3 agentes)
1. **Ejecutor** = la sesión principal. Toma UNA tarea de `docs/tareas/` y sigue el skill `ejecutar-tarea`.
2. **`revisor-codigo`** (subagente): revisa el diff contra la tarea/spec, la calidad y los tests.
3. **`revisor-seguridad`** (subagente): revisa RLS, aislamiento entre empresas, webhooks, secretos, datos personales e inyección de prompts.

Una tarea no está terminada hasta que los dos revisores aprueban (sin hallazgos bloqueantes) y la verificación de la tarea pasa.

## Organización
- Tareas: `docs/tareas/pendientes/` → `en-curso/` → `hechas/` (plantilla: `docs/tareas/_plantilla.md`, skill `nueva-tarea`)
- Specs de features: `docs/specs/` · Decisiones tomadas: `docs/decisiones.md`
- Estado de la sesión: `.claude/contexto/ESTADO.md` (se lee al empezar y se actualiza al cerrar)
- Evals de la IA: `evals/`
- Una sesión por tarea; sesión nueva al cambiar de tema.

## Idioma
Código, nombres de tablas, columnas y variables en inglés. Docs, tareas, commits y comunicación en español.
