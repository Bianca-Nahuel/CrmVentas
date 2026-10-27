# Estado del proyecto

_Última actualización: 2026-10-26 (tarea 007, prueba local y real)_

## Hecho

- Tarea 007 (catálogo Excel y web): implementada en la nube (rama `claude/vibrant-dirac-ujisy4`) y probada en local el 2026-10-26. Ver el "Resultado" en `docs/tareas/hechas/007-catalogo-excel-y-web.md` y las decisiones #48–#62.
  - Migraciones 0011–0013: `catalog_products` (búsqueda con unaccent + trigramas), `catalog_imports`, `catalog_import_rows`, `product_snapshots`, `ai_runs.catalog_citations`, cola `catalog-refresh`.
  - `npm run dev:import-catalog` (vista previa, `--apply`, `--revert`) y `npm run dev:test-extractor` (un pedido, con las protecciones SSRF).
  - Herramientas `buscar_productos`, `ver_producto` y `calcular_cantidad`; marcas que escribe el código; prompt v2.
  - En la sesión local: DeepSeek pasó a `catalogTools: 'final_tool'` (probe 0/3 y 3/3); opción `exclusive` en el extractor (el JSON-LD de la web real trae la promo como único precio); el render saca la unidad repetida ("por m² por m²").
  - Evals: catálogo 22/26 con DeepSeek `final_tool` (Haiku 17/26); regresión de la 006 77/80. 579 tests. Prueba real por WhatsApp OK (precio de la web con promo y link, 45 m² → 23 cajas, stock → deriva). Los dos revisores aprobaron (solo menores, aplicados).
  - Empresa de prueba (`Cerámicos Demo`): config v4 con `catalog` y el extractor para lecer.com.ar; catálogo real importado (4659 productos). Commiteada en la rama.

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
  - Decisiones #36–#47 y deuda de la 006. 371 tests. Prueba real OK. Aprobada por los dos revisores. Commiteada (1930c1c).
- Tarea 005: envío por outbox `outbound_messages` (migraciones 0006/0007, cola `whatsapp-outbound` singleton por chat), worker visto → escribiendo → enviar (claim atómico, lock por canal, nunca reenvía un `sending`, 5xx/timeout = `unknown_outcome`), ecos por `message.any` (de una persona → `user` y la IA pausada 12 h), acuses por `message.ack`, `blocked_risk` pausa el canal sin vencimiento. Commiteada (5100f3d).
- Tarea 004: webhook de WAHA con HMAC → cola `whatsapp-inbound` → worker idempotente. Commiteada (f125cc0).
- Tarea 003: tablas de mensajería con RLS y FKs compuestas. Commiteada (cdc370b).
- Tarea 002: NestJS + Better Auth, tres usuarios de base, `TenantGuard`. Commiteada (67b52bf).
- Tareas 000 y 001: proyecto ordenado y entorno de desarrollo.

## En curso

- (nada)

## Siguiente

- **Plan del agente conversacional (2026-10-27, decisión #63):** tareas 010 y 015–022 en `docs/tareas/pendientes/`. Orden sugerido: 010 (prompt v3, 1 o 2 mensajes, no repreguntar) → 015 (controles y reformulación) → 016 (reintento, visto, espera adaptativa) → 017 (modo acompañante y textos contextuales) → 020 (extracción) → 019 (contexto del contacto) → 018 (audios) → 021 (categorización) → 022 (fotos del catálogo). La 017 cambia una regla de `CLAUDE.md` al cerrarse. Config conversacional propuesta para cerámicos: `max_questions_per_message: 1`, `availability`/`cannot_answer` como `after_fields`, sin `custom_recomendacion` y estilo en `custom_instructions`.
- `.claude/settings.json` quedó afuera del commit de la 006 (cambio del usuario): el revisor de seguridad sugirió volver a "preguntar" `node *`, `docker compose *` y `npm run db:*`.
- Tarea 007: commiteada y pusheada en `claude/vibrant-dirac-ujisy4`; falta mergearla a `main`. `package-lock.json` quedó modificado solo por `npm install` (saca `"dev": true` de los binarios de esbuild): no va en el commit.
- Seguimientos de la 007 (ver "Deuda pendiente (tarea 007)" en `docs/decisiones.md`): error de OpenRouter que deja al cliente sin respuesta y sin detalle registrado; lead caliente al que se le responde (CAT24, C16); 45 m² sin calcular en el primer turno (CAT05); parser `number_dot`.
- Empresa de prueba: actualizar o desactivar el disparador `custom_recomendacion` ("todavía no hay catálogo"); evaluar `availability_source: web` (la web muestra "PRODUCTO SIN STOCK"). El Excel real trae filas partidas y "�" en lugar de "á": pedirle a la empresa un archivo limpio.
- Proponer al usuario actualizar la línea de disponibilidad de `CLAUDE.md` (decisión #56).
- Tarea 008 (créditos): reemplazar `NoopBudgetGuard`; ver la deuda de la 006 (doble llamada si falla la T2, tope de corridas por conversación, límite de gasto en la clave de OpenRouter).
- Tarea 014: volver a activar la IA en una conversación derivada (hoy se cierra a mano en la base para probar) y mostrar el resumen como "automático, no verificado".
- Antes de `npm run test`, bajar `npm run dev:api` (comparten la cola de pg-boss).
- Evals: siempre con `--max-usd`. Una corrida completa de la 006 con DeepSeek cuesta ~USD 0,07 y los 26 de catálogo ~USD 0,06. Correr sin `--rubro` ni `--case` también incluye los de catálogo. En Windows, TaskStop corta el shell pero no el proceso node: terminarlo por PID (para `dev:api`, el que escucha en el 3000) y esperar a que venza su registro en `pgboss.instance` antes de `npm run test`.
- Tarea de endurecimiento de seguridad: ver las secciones de "Deuda" en `docs/decisiones.md`.

## Bloqueos / pendientes externos

- Trámite de Tech Provider en Meta (para la API oficial): no iniciado.
- En otra máquina con un volumen de Postgres viejo hay que crear `ventas_auth` a mano (comando en `docs/entorno-dev.md`).
- Configurar un límite de gasto en la clave de OpenRouter y la privacidad (ZDR) a nivel cuenta: lo hace el usuario.
