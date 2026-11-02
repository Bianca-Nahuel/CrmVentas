# Tarea 011: Canales, conectar un número de WhatsApp por QR desde el panel

## Contexto

Hoy un número se conecta solo a mano y en desarrollo: `npm run dev:create-channel` crea el canal y la sesión
de WAHA, el QR se escanea desde el dashboard de WAHA y el número se carga con `--phone` sin verificarlo. Para
el primer cliente real, el owner tiene que poder conectar su número desde el panel, ver si está conectado y
reconectarlo si se cae, sin tocar WAHA ni la terminal.

La pantalla "Canales" del menú del panel todavía no tiene nada para conectar: la 014 dejó "Números y
vendedores" (asignar vendedores) y la 024 dejó para esta tarea el levantar la pausa de envíos.

Spec: `docs/specs/canales.md`. Referencias:

- decisión #27 y la sección "Para la tarea 008 (alta de canales y QR desde el panel)" de
  `docs/decisiones.md` (es esta tarea: la numeración cambió);
- "Secuestro de número entre empresas" y lo de `risk_accepted_by` en la deuda de la tarea 003, en el mismo
  archivo;
- los "Resultado" de la 004 (webhook de WAHA), la 005 (envío, pausa por 463/475), la 024 (proveedor falso)
  y la 025 (tiempo real, `channel.updated`).

## Objetivo

El owner o el admin da de alta un número desde el panel: acepta el riesgo, escanea el QR y ve el canal
conectado con el número que escaneó, sin recargar. También puede desconectarlo, reconectarlo con un QR nuevo
y levantar la pausa de envíos. Todo pasa por la interfaz `WhatsAppProvider`, y el navegador nunca habla con
WAHA.

## Antes de empezar

1. La 025 tiene que estar commiteada (lo está: `46b6e92`, rama `claude/tiempo-real-bandeja`).
2. Leé la spec, `CLAUDE.md`, los skills `webhook-whatsapp` y `migracion-db`, `.claude/rules/whatsapp.md`, el
   `WahaClient` y `waha.provider.ts`, el proveedor falso de la 024, `scripts/create-dev-channel.ts` y
   `scripts/lib/waha-session.ts`.
3. **Consultá la documentación actual de WAHA** (la versión que corre en `infra/`):
   - endpoints para obtener el QR (imagen o valor crudo), arrancar, detener, cerrar sesión (logout) y borrar
     una sesión;
   - cada cuánto vence el QR y qué estados de `session.status` pasan durante la vinculación;
   - dónde viene el número conectado (`me.id`) en el evento `session.status` con `WORKING`;
   - **cuántas sesiones permite la edición que usamos (Core o Plus).** Si Core admite una sola, decímelo en
     el plan: cambia qué se puede ofrecer.
4. Proponé en el plan y **esperá mi OK**:
   - cómo se extiende `WhatsAppProvider` para la conexión (por ejemplo `connectSession`, `getPairingQr`,
     `disconnectSession`) y qué `capability` la describe, sabiendo que la Cloud API se conecta de otra
     forma;
   - cómo llega el QR al panel: pedir cada pocos segundos, SSE o lo que propongas. Tené en cuenta que el QR
     cambia y que el estado ya viaja por `channel.updated`;
   - **el mismo número en dos empresas:** ¿se bloquea? Pensalo como seguridad (alguien que vincula el número
     de otro) y como producto (una empresa con dos sucursales que usa el sistema dos veces);
   - qué pasa con un canal `pending` abandonado (sin escanear): ¿vence?, ¿se borra la sesión de WAHA?

## Pasos / requisitos

1. **Migración** (skill `migracion-db`; nunca editar una migración aplicada):
   - `channels.phone_number` admite NULL mientras el canal está `pending`, con un CHECK del estilo
     "`connected` ⇒ tiene número". El CHECK E.164 y `UNIQUE (tenant_id, phone_number)` siguen valiendo
     cuando hay número;
   - columnas para el motivo de la desconexión y para quién levantó la pausa y cuándo, si hacen falta
     (códigos, sin datos personales);
   - grants mínimos y RLS como siempre. `ventas_app` no tiene que poder escribir `provider`, `external_id`
     ni `connection_type` desde ningún endpoint.
2. **Proveedor:**
   - métodos de conexión en `WhatsAppProvider`, implementados en WAHA y en el proveedor falso. El falso
     tiene que poder simular el escaneo en los tests y los e2e (por ejemplo, una función de prueba que emite
     `session.status` `WORKING` con un número);
   - el evento normalizado `session.status` lleva el número conectado (normalizado a E.164 dentro de
     `providers/waha/`).
3. **Worker de `session.status`** (en `inbound.service.ts`):
   - con `connected`, completa `phone_number` desde el evento;
   - si el canal ya tenía otro número, no lo pisa: el canal pasa a `disconnected` con su motivo y se registra
     un aviso (log `warn` sin el número);
   - si el número ya está en otro canal de la empresa, no reintenta para siempre: el canal queda
     `disconnected` con su motivo y el panel lo explica;
   - publica `channel.updated` (ya lo hace con el estado; confirmalo también para el número y el motivo).
4. **API** (contratos zod en `*.contracts.ts`, OpenAPI y cliente regenerado):
   - `POST /api/channels`: nombre y aceptación explícita del riesgo. Crea el canal `pending` y la sesión.
     `external_id` lo genera el sistema y `risk_accepted_by` sale del usuario del request;
   - `GET /api/channels/:id/pairing`: el QR vigente (o "ya conectado" / "vencido"), con
     `Cache-Control: no-store`. Nunca se loguea;
   - `POST /api/channels/:id/reconnect`: un QR nuevo para un canal `disconnected`, mismo canal, mismo
     historial;
   - `POST /api/channels/:id/disconnect`: cierra la sesión en el proveedor y deja el canal `disconnected`,
     con confirmación en el panel;
   - `POST /api/channels/:id/resume-sending`: levanta `sending_paused_until`. No toca la sesión y registra
     quién y cuándo;
   - permisos con `@RequirePermission` (`channel:connect` / `channel:disconnect`). Otra empresa → 404;
   - el listado de canales que ya existe (`GET /api/channels`) suma estado, número, motivo y pausa.
5. **Panel (Angular, reglas de `.claude/rules/frontend.md`):**
   - la pantalla **Canales** (`/canales`): lista de números con su estado (ícono y texto, nunca solo color),
     botón "Conectar un número", y "Reconectar", "Desconectar" o "Levantar pausa" según el estado;
   - el flujo de alta, en un diálogo o una página:
     - nombre y aceptación del riesgo (texto de la spec);
     - QR con instrucciones paso a paso;
     - estado en vivo ("Esperando el escaneo…", "¡Conectado! +54…");
     - si el QR venció, se renueva solo o hay un botón;
   - el estado llega por el tiempo real de la 025 (`channel.updated`), sin recargar;
   - "Números y vendedores" sigue igual (o se integra; decilo en el plan).
6. **Script de desarrollo:** `dev:create-channel` deja de pedir `--phone` (el número sale del escaneo) o se
   reemplaza por el flujo del panel. Documentalo en `docs/entorno-dev.md`.

## Criterios de aceptación

- [ ] Desde el panel, el owner conecta un número: acepta el riesgo, ve el QR, escanea y ve el canal
      conectado con el número escaneado, sin recargar.
- [ ] El número del canal sale del escaneo. Un reescaneo con otro teléfono no pisa el número: el canal queda
      desconectado con su motivo.
- [ ] Desconectar, reconectar (QR nuevo, mismo historial) y levantar la pausa funcionan y quedan
      registrados.
- [ ] El seller y el viewer no pueden conectar, desconectar, ver el QR ni levantar la pausa (403). Otra
      empresa recibe 404.
- [ ] El QR no se cachea, no se loguea y solo pasa por la API. La clave de WAHA nunca llega al navegador.
- [ ] Ninguna lógica fuera de `providers/` pregunta qué proveedor es.
- [ ] `npm run test`, `lint`, `typecheck`, `build` y `e2e:web` pasan.

## Verificación (obligatoria)

1. **Tests de la API (con el proveedor falso):**
   - alta: canal `pending` sin número, `external_id` generado por el sistema, `risk_accepted_by` = el
     usuario. Un `external_id` o un `provider` en el body se ignoran o dan 400;
   - escaneo simulado: `connected` con el número; `channel.updated` publicado;
   - reescaneo con otro número: queda `disconnected` con motivo y el número viejo no cambia;
   - número repetido en la empresa: `disconnected` con motivo, sin reintentos infinitos;
   - el caso del mismo número en dos empresas, según lo que se decida;
   - desconectar, reconectar y levantar la pausa, cada uno con su registro;
   - permisos: seller y viewer → 403; otra empresa → 404;
   - `GET .../pairing` con `Cache-Control: no-store` y sin el QR en los logs.
2. **Migración:** CHECK (`connected` sin número → falla), UNIQUE con NULL (dos canales `pending` sin número
   en la misma empresa → permitido) y RLS entre empresas.
3. **Playwright con el proveedor falso:**
   - el owner da de alta un canal, ve el QR, se simula el escaneo y el estado cambia a conectado con el
     número, sin recargar;
   - desconectar con confirmación y reconectar;
   - el seller no ve "Canales" en el menú y, si entra por URL, no ve las acciones.
4. **Prueba real con WAHA (con mi OK, con el número de prueba):** alta desde el panel, escaneo con el teléfono
   de prueba, mensaje entrante que llega a la bandeja, desconectar y reconectar.
5. **Capturas** de Canales (lista con estados, alta con el QR, conectado, desconectado y pausado), en claro y
   oscuro, a 375 y 1280 px.
6. `git status`: sin `.env`.

## Fuera de alcance

- Conexión oficial (Cloud API de Meta, alta embebida).
- Vincular por **código de emparejamiento** (el número + un código, sin QR), útil cuando se conecta desde el
  mismo celular. Si WAHA lo soporta, anotalo como seguimiento.
- Borrar un canal con su historial.
- Varias sesiones por canal o cambiar el número de un canal existente.
- Avisos por email o push de un canal caído.
- Cambiar las reglas, los prompts o la configuración del agente.

## Entregable

Resumen:

- archivos tocados;
- cómo se extendió `WhatsAppProvider` y cómo llega el QR al panel;
- qué se decidió sobre el número en dos empresas y los canales `pending` abandonados;
- resultado de cada punto de la verificación, con las capturas;
- veredicto de `revisor-codigo` y `revisor-seguridad`;
- decisiones nuevas en `docs/decisiones.md`;
- mensaje de commit propuesto.

## Resultado

_Hecha el 2026-11-02 en la rama `claude/canales-qr` (sale de `46b6e92`, tarea 025)._

### Qué se hizo

- **Proveedor (#94):** `WhatsAppProvider` suma `capabilities.pairing`, `connectionType`, `sessionIdFor`,
  `openSession`, `restartPairing`, `getPairingQr` y `closeSession`. El alta usa el proveedor con
  `pairing === 'qr'`; nada fuera de `providers/` pregunta cuál es. WAHA (`waha-session.ts`, `waha-pairing.ts`)
  y el falso (sesiones en memoria y un PNG fijo; el escaneo se simula con el webhook firmado).
- **QR:** la API lo pide a WAHA en cada `GET /api/channels/:id/pairing` (`Cache-Control: no-store`, nunca en
  logs ni por SSE, validado como PNG ≤ 100 kB). El panel lo vuelve a pedir cada 5 s y apenas llega un
  `channel.updated`; vive en una señal y se borra al cerrar el diálogo.
- **Migraciones 0019/0020:** `phone_number` NULL mientras está `pending` (CHECK `connected` ⇒ número),
  `UNIQUE (phone_number)` global, `connected_at` / `disconnected_at` / `disconnect_reason`, `channel_events`
  con RLS, `DELETE` solo de canales que nunca se conectaron, `resolve_channel` que descarta las sesiones
  rechazadas y la cola `whatsapp-session-close`.
- **Mismo número en dos empresas:** bloqueado (#95). **Canales `pending` abandonados:** vencen solos cuando
  WAHA agota los QR (`pairing_expired`) y se pueden cancelar (#96). Tope de 20 sesiones abiertas por
  empresa (#98).
- **Panel:** `/canales` con estado (ícono + texto), motivo, pausa y acciones; diálogo de alta en dos pasos.
  A pedido del usuario, sin cartel de riesgo ni casilla (#101).

### Archivos

- API: `drizzle/0019_channels_pairing.sql`, `0020_channels_pairing_rls.sql` (+ snapshots y journal),
  `db/schema/messaging.ts`, `whatsapp/provider.ts`, `providers/waha/*` (`waha-session.ts`, `waha-pairing.ts`,
  `waha-client.ts`, `waha-normalize.ts`, `waha.provider.ts`), `providers/fake/*`, `whatsapp.module.ts`,
  `inbound/inbound.service.ts`, `inbound/session-close.{job,worker}.ts`, `jobs.module.ts`,
  `inbox/channel-connection.service.ts`, `channels.{contracts,service}.ts`, `inbox.{controller,module}.ts`,
  `inbox.contracts.ts`, `openapi.json`, `scripts/create-dev-channel.ts`, `scripts/lib/waha-session.ts`,
  `scripts/seed.ts`; `libs/shared/src/whatsapp/events.ts`.
- Tests de la API: `channels-connection.test.ts`, `waha-pairing.test.ts` (nuevos) y ajustes en
  `waha-normalize`, `waha-provider`, `waha-send`, `inbound-worker`, `outbound-helpers`, `realtime`,
  `waha-inbound` y `messaging-isolation`.
- Panel: `api/channels-api.ts`, `api/generated/*`, `pages/channels/{channels-page,connect-channel-dialog,
channel-state}.ts` (+ spec), rutas, la página de miembros y el diálogo de asignar (número null), tokens
  (`--qr-surface`); e2e `channels.spec.ts`, `capturas.spec.ts`, `helpers.ts` y `reply.spec.ts`.
- Docs: `docs/specs/canales.md`, `docs/decisiones.md` (#94 a #101 y la deuda de la 011), `docs/entorno-dev.md`.

### Verificación

- `npm run test`: API 722/722 y panel 101/101 (12 archivos). Lint y typecheck OK.
- Playwright: corrida completa 102/107 antes de los arreglos; las 5 fallas eran de `reply` y de las capturas
  de respuesta, que buscaban a "Carla Estados" entre las 50 conversaciones más recientes (las corridas
  anteriores la sacaban de la lista). Se buscan por nombre. Después de los cambios: `channels`, `capturas` y
  `reply` 84/84.
- Capturas de Canales (23 a 31) en claro y oscuro, a 375 y 1280 px: aprobadas por el usuario.
- **No hecho:** la prueba real con WAHA (requiere el OK del usuario y el número de prueba) y `db:migrate`
  sobre una base vacía.
- Bundle inicial: 501,25 kB (1,25 kB arriba del aviso de 500 kB).

### Revisores

- **revisor-codigo:** APROBADO. Se corrigieron: el diálogo decía "venció" ante un escaneo rechazado (ahora
  `rejected` con el motivo), el motivo al agotarse los QR de una reconexión, el `WORKING` viejo después de
  desconectar, desconectar un canal que nunca se conectó (409) y el logout fallido. Las decisiones faltantes
  se agregaron. El trabajo con WAHA dentro de la transacción quedó como deuda.
- **revisor-seguridad:** APROBADO (sin CRÍTICO ni ALTO). Se corrigieron los dos MEDIO: un `connected` sin número
  ya no reusa el número viejo después de un QR, y el logout fallido no se da por bueno (la cola reintenta).
  Los BAJO (mensajes antes del rechazo, WAHA dentro de la transacción, número reservado para siempre,
  `empresas.local.json` sin ignorar) quedaron en la deuda de la 011.
- Los cambios de la revisión y la quita del cartel no pasaron por una segunda ronda de los revisores.

### Decisiones

#94 a #101 en `docs/decisiones.md`.
