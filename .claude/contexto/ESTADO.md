# Estado del proyecto

_Última actualización: 2026-10-26_

## Hecho

- Tarea 006 (reemplazó a "primera respuesta de la IA"): agente configurable con puntaje de lead y calificación antes de derivar.
  - Config del agente versionada en `tenant_configs`, validada con zod en `libs/shared`, cargada con `npm run dev:set-config`. Fixtures de cerámicos e inmobiliaria.
  - Pipeline `ai-reply`: debounce 10 s, cola singleton por conversación, T1 con filtros, modelo fuera de transacción, T2 con lock y los mismos filtros.
  - El puntaje se calcula en código y `decide()` es una función pura; un texto generado solo sale como `SafeReply`, después de los controles de salida.
  - Prompt v1 en dos capas: `<negocio>`, `<datos_del_cliente>` y `<conversacion>`, con escape. Detector en código de disparadores críticos.
  - OpenRouter con `require_parameters`, `data_collection: 'deny'` y `zdr`, razonamiento `low` y ciclo de herramientas listo para la 007.
  - Modelo por defecto `deepseek/deepseek-v4.1-flash` (~USD 0,0009 por turno); `ALLOWED_MODELS` también tiene Haiku 5.5 y GPT-6 Luna.
  - `PresenceService`: visto + "escribiendo…" mientras la IA piensa, que bajó la respuesta de ~25 s a ~19 s.
  - Migraciones 0008–0010 (la 0010 deja a los workers leer la empresa activa).
  - Evals: 80 casos en `evals/`; DeepSeek 77/80 con todas las metas.
  - Decisiones #36–#47 y deuda de la 006. 371 tests. Prueba real OK. Aprobada por los dos revisores. **Sin commitear.**
- Tarea 005: envío por outbox `outbound_messages` (migraciones 0006/0007, cola `whatsapp-outbound` singleton por chat), worker visto → escribiendo → enviar (claim atómico, lock por canal, nunca reenvía un `sending`, 5xx/timeout = `unknown_outcome`), ecos por `message.any` (de una persona → `user` y la IA pausada 12 h), acuses por `message.ack`, `blocked_risk` pausa el canal sin vencimiento. Commiteada (5100f3d).
- Tarea 004: webhook de WAHA con HMAC → cola `whatsapp-inbound` → worker idempotente. Commiteada (f125cc0).
- Tarea 003: tablas de mensajería con RLS y FKs compuestas. Commiteada (cdc370b).
- Tarea 002: NestJS + Better Auth, tres usuarios de base, `TenantGuard`. Commiteada (67b52bf).
- Tareas 000 y 001: proyecto ordenado y entorno de desarrollo.

## En curso

- (nada)

## Siguiente

- Commit de la tarea 006 (lo confirma el usuario). Dejar `.claude/settings.json` afuera: es un cambio del usuario, y el revisor de seguridad sugirió volver a "preguntar" `node *`, `docker compose *` y `npm run db:*`.
- Tarea 007 (catálogo Excel y web): el ciclo de herramientas de `OpenRouterClient` ya está y `--tools-probe` dio OK con Haiku y Sonnet; a DeepSeek no se le corrió la prueba de herramientas (correr `npm run evals -- --model deepseek/deepseek-v4.1-flash --tools-probe --case C01 --max-usd 0.02`). Los controles de salida tienen `parseMarkers`/`render` listos para `{{precio:SKU}}`. Hoy un precio marca `cannot_answer`.
- Tarea 008 (créditos): reemplazar `NoopBudgetGuard`; ver la deuda de la 006 (doble llamada si falla la T2, tope de corridas por conversación, límite de gasto en la clave de OpenRouter).
- Tarea 014: volver a activar la IA en una conversación derivada (hoy se cierra a mano en la base para probar) y mostrar el resumen como "automático, no verificado".
- Antes de `npm run test`, bajar `npm run dev:api` (comparten la cola de pg-boss).
- Evals: siempre con `--max-usd`. Una corrida completa con DeepSeek cuesta ~USD 0,07. Quedan ~USD 0,60 del presupuesto de pruebas que separó el usuario.
- Tarea de endurecimiento de seguridad: ver las secciones de "Deuda" en `docs/decisiones.md`.

## Bloqueos / pendientes externos

- Trámite de Tech Provider en Meta (para la API oficial): no iniciado.
- En otra máquina con un volumen de Postgres viejo hay que crear `ventas_auth` a mano (comando en `docs/entorno-dev.md`).
- Configurar un límite de gasto en la clave de OpenRouter y la privacidad (ZDR) a nivel cuenta: lo hace el usuario.
