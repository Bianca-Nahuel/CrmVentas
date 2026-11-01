# Entorno de desarrollo local

Postgres 18 (con pgvector) y WAHA corren en Docker. El backend (NestJS) y el frontend
(Angular) corren en el host, fuera de Docker.

| Servicio                           | Dirección en el host    |
| ---------------------------------- | ----------------------- |
| Postgres                           | `localhost:5432`        |
| WAHA (API, dashboard y Swagger)    | `http://localhost:3001` |
| API (NestJS, `npm run dev:api`)    | `http://localhost:3000` |
| Panel (Angular, `npm run dev:web`) | `http://localhost:4200` |

Los dos puertos se publican solo en `127.0.0.1`: no se ven desde otras máquinas de la red.

## 1. Requisitos

- Docker Desktop (en Windows, con el backend WSL2), corriendo.
- Comprobar: `docker --version` y `docker compose version`.

## 2. Crear el `.env`

En la raíz del repo:

```bash
cp .env.example .env
```

Reemplazá cada `cambiar` por un valor aleatorio, por ejemplo con `openssl rand -hex 16`.
Las contraseñas de `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD` y `DB_AUTH_PASSWORD` tienen que coincidir con las
que aparecen dentro de `DATABASE_URL_MIGRATIONS`, `DATABASE_URL` y `DATABASE_URL_AUTH`.
`BETTER_AUTH_SECRET` tiene que tener al menos 32 caracteres (`openssl rand -hex 32`).

El `.env` está en `.gitignore` y **nunca se commitea**.

> Postgres lee el `.env` solo la primera vez que se crea el volumen. Si después cambiás
> usuarios o contraseñas de la base, tenés que reiniciarla desde cero (punto 6).

## 3. Levantar y bajar el entorno

Desde la raíz del repo:

```bash
docker compose -f infra/docker-compose.yml up -d     # levantar
docker compose -f infra/docker-compose.yml ps        # estado (Postgres debe estar "healthy")
docker compose -f infra/docker-compose.yml logs -f   # ver logs
docker compose -f infra/docker-compose.yml down      # bajar (los datos se conservan)
```

`infra/docker-compose.yml` incluye `infra/servicios.yml` y le pasa el `.env` de la raíz.

## 4. Conectarse a la base (DBeaver o psql)

Host `localhost`, puerto `5432`, base `ventas` (`POSTGRES_DB`).

| Usuario        | Para qué                                                                                  | Variable                  |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| `ventas_owner` | Solo migraciones (crear/alterar tablas) y limpieza de los tests e2e. La API no la recibe. | `DATABASE_URL_MIGRATIONS` |
| `ventas_app`   | El backend en ejecución, y para probar consultas como las vería la app.                   | `DATABASE_URL`            |
| `ventas_auth`  | Solo Better Auth (pool propio). Únicamente las tablas de autenticación.                   | `DATABASE_URL_AUTH`       |

Con psql, sin instalar nada en el host:

```bash
docker compose -f infra/docker-compose.yml exec postgres psql -U ventas_app -d ventas
```

En DBeaver: nueva conexión PostgreSQL con esos datos y la contraseña del `.env`.

## 5. Conectar un número en WAHA

1. Abrí `http://localhost:3001/dashboard` y entrá con `WAHA_DASHBOARD_USERNAME` /
   `WAHA_DASHBOARD_PASSWORD`. Si el dashboard pide la API key, es `WAHA_API_KEY`.
2. Creá el canal y su sesión con el script (no desde el dashboard: así la sesión queda con el webhook
   firmado y el nombre que genera el backend):

   ```bash
   npm run dev:create-channel -- --tenant ceramicos-demo --name "Ventas prueba" --phone +549XXXXXXXXXX
   ```

3. En el dashboard, abrí la sesión que imprimió el script y escaneá el QR desde WhatsApp →
   Dispositivos vinculados.

**Solo se usa el número de prueba del equipo. Nunca un número personal ni el de un cliente.**

Las llamadas a la API de WAHA llevan el header `X-Api-Key: <WAHA_API_KEY>`.

No hay webhook global. Cada sesión tiene el suyo, configurado por el script: `WAHA_WEBHOOK_URL`
(`http://host.docker.internal:3000/api/webhooks/waha`, la API NestJS en el host), firmado con
`WAHA_WEBHOOK_HMAC_KEY` (HMAC-SHA512), con los eventos:

- `message.any`: mensajes entrantes y propios (`fromMe: true`). Un propio que no mandó el sistema lo
  escribió una persona desde el teléfono: se guarda como `user` y pausa la IA en esa conversación.
- `message.ack`: acuses de lo enviado (actualiza `messages.status`: `sent` → `delivered` → `read`).
- `session.status`: cambios de estado de la sesión (actualiza `channels.status`).

No se suscribe `message`: `message.any` ya trae los entrantes y con los dos cada uno llegaría dos veces.

Si cambiás `WAHA_WEBHOOK_URL` o `WAHA_WEBHOOK_HMAC_KEY`, o si la sesión se creó antes de la tarea 005 (solo
con `message` y `session.status`), la sesión sigue con la configuración vieja. Para reaplicarla sin volver
a escanear el QR:

```bash
npm run dev:sync-channel-webhook -- --session ch_<id>
```

La imagen de WAHA está fijada a `devlikeapro/waha:latest-2026.8.1`.

### Enviar un mensaje de prueba

Con `npm run dev:api` corriendo (el worker de la API es el que manda), en una conversación donde el
contacto escribió en las últimas 24 h:

```bash
npm run dev:send -- --tenant <id de la empresa> --conversation <id> --text "Hola, ¿en qué te ayudo?"
```

Pasa por las mismas reglas que la IA: sin un entrante del contacto, con la ventana vencida, con el contacto
bloqueado o con el canal desconectado o pausado, queda `rejected`. Antes de enviar, el worker marca visto y
muestra "escribiendo…" unos segundos.

Si WAHA avisa riesgo de bloqueo (errores 463/475), el canal queda con los envíos pausados sin vencimiento y
no se reinicia la sesión. Para levantar la pausa (después de bajar el ritmo):

```bash
npm run dev:resume-channel -- --tenant <id de la empresa> --channel <id del canal>
```

La sesión queda guardada en un volumen, así que no hay que reescanear el QR en cada reinicio.

**Antes de `npm run test`, bajá `npm run dev:api`.** La cola de pg-boss vive en la misma base que los
tests: el worker de la API de desarrollo tomaría sus trabajos. El test de WAHA lo detecta y corta con un
mensaje.

## 6. Reiniciar la base desde cero

```bash
docker compose -f infra/docker-compose.yml down -v
docker compose -f infra/docker-compose.yml up -d
```

`down -v` borra **todos** los volúmenes: los datos de Postgres **y las sesiones de WAHA**
(hay que volver a escanear el QR). Al levantar, `infra/postgres/init/01-init.sh` vuelve a
crear las extensiones y el usuario de la aplicación.

## 7. Por qué tres usuarios de base

La RLS (Row Level Security) **no se aplica** a los superusuarios ni al dueño de las tablas.
Si la aplicación se conectara con el usuario dueño, las políticas se ignorarían en silencio
y un cliente podría ver datos de otro. Por eso:

- `ventas_owner`: solo para correr migraciones.
- `ventas_app`: el que usa el backend. Nunca es dueño de tablas y no tiene `BYPASSRLS`
  (tampoco `SUPERUSER`, `CREATEDB` ni `CREATEROLE`).
- `ventas_auth`: solo lo usa Better Auth, con su propio pool. Mismas restricciones que
  `ventas_app`. Better Auth tiene que leer usuarios y sesiones antes de conocer la empresa
  (buscar por email, validar el token), así que esas tablas no pueden filtrarse por tenant.
  Separarlo garantiza que un bug del código de negocio nunca pueda leer contraseñas ni
  sesiones: `ventas_app` no tiene ningún permiso sobre `accounts`, `sessions` ni
  `verifications`, y `ventas_auth` no tiene ninguno sobre las tablas de negocio.

Gracias a los privilegios por defecto, cada tabla que cree `ventas_owner` en `public` le da
automáticamente a `ventas_app` solo `SELECT, INSERT, UPDATE, DELETE` (y `USAGE, SELECT`
sobre las secuencias). `ventas_app` no puede crear, alterar ni borrar tablas. `ventas_auth`
no tiene privilegios por defecto: sus permisos están en la migración
`apps/api/drizzle/0001_auth_permissions_rls.sql` (que además le revoca a `ventas_app` lo que
no le corresponde en las tablas de autenticación).

**Si tu volumen de Postgres es anterior a la tarea 002**, el script de inicio no se vuelve a
ejecutar: agregá `DB_AUTH_USER`, `DB_AUTH_PASSWORD`, `DATABASE_URL_AUTH`, `BETTER_AUTH_SECRET`,
`BETTER_AUTH_URL` y `TRUSTED_ORIGINS` al `.env` (ver `.env.example`) y creá el rol a mano,
reemplazando `<PASS_AUTH>` por el mismo valor de `DB_AUTH_PASSWORD`:

```bash
docker compose -f infra/docker-compose.yml exec postgres psql -U ventas_owner -d ventas -v ON_ERROR_STOP=1 -c "CREATE ROLE ventas_auth LOGIN PASSWORD '<PASS_AUTH>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT; GRANT CONNECT ON DATABASE ventas TO ventas_auth; GRANT USAGE ON SCHEMA public TO ventas_auth;"
```

O reiniciá la base (punto 6).

**Para las migraciones:** cada tabla de negocio tiene que llevar

```sql
ALTER TABLE <tabla> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <tabla> FORCE ROW LEVEL SECURITY;
```

## 8. Panel (Angular)

```bash
npm run dev:api     # API en :3000
npm run dev:web     # panel en http://localhost:4200
```

- **Mismo origen:** el navegador solo habla con `localhost:4200`. El servidor de desarrollo de Angular
  reenvía `/api` a `http://localhost:3000` (`apps/web/proxy.conf.json`), así la cookie de sesión
  (`HttpOnly`, `SameSite=Lax`) viaja sin CORS. `TRUSTED_ORIGINS` tiene que incluir
  `http://localhost:4200` (ya está en `.env.example`).
- **Control de origen en la API:** todo `POST`/`PUT`/`PATCH`/`DELETE` sin `Origin`, o con un `Origin` fuera de
  `TRUSTED_ORIGINS`, recibe 403 (`apps/api/src/http/origin-guard.ts`). Solo se exceptúan los webhooks
  (`/api/webhooks/*`, firmados con HMAC). Para probar la API con `curl`, mandá
  `-H "Origin: http://localhost:3000"`.
- **Usuarios de prueba:** los del seed (`npm run db:seed`). No hay registro público (`disableSignUp`); las
  cuentas se crean con `auth.api.createUser` del plugin admin.
- **Página del sistema de diseño:** `http://localhost:4200/dev/diseno`. Solo existe en desarrollo: el build de
  producción reemplaza `src/app/dev/dev.routes.ts` por una lista vacía (`fileReplacements`).
- **Tests:** `npm run test:web` (unitarios, Vitest) y `npm run e2e:web` (Playwright contra la API real con el
  seed; levanta la API y el panel si no están corriendo). La primera vez: `npx playwright install chromium`
  dentro de `apps/web`. Capturas: `npm run e2e:web -- capturas` → `apps/web/test-results/capturas/`.

> Igual que con `npm run test`: si ya hay una `dev:api` corriendo con otro código, bajala antes de los e2e.
> Dos APIs comparten la cola de pg-boss y se reparten los trabajos (entrantes, envíos, IA).

- **Tiempo real (tarea 025):** el panel abre un stream SSE en `GET /api/events` (una conexión por pestaña
  visible).
  - **Proxy de desarrollo:** `apps/web/proxy.conf.json` lo reenvía sin cambios. El proxy de Vite no junta
    los bytes ni tiene timeout, y cuando el navegador corta, corta también la conexión con la API (lo cubren
    los e2e de `realtime.spec.ts`).
  - **Límite del navegador:** sin HTTP/2 (como en `localhost:4200`), el navegador abre como mucho 6
    conexiones por origen. Con muchas pestañas visibles de la bandeja pueden faltar conexiones para el
    resto de los pedidos. Las pestañas ocultas cierran su stream a los 10 s. En producción (HTTP/2 con
    Caddy) no pasa.
  - **Variables opcionales** (en `.env.example`): `REALTIME_HEARTBEAT_SECONDS` (latido, 25),
    `REALTIME_REVALIDATE_SECONDS` (revalidación de sesión y números, 15) y `REALTIME_MAX_STREAMS_PER_USER`
    (5 por instancia).
  - **Cuidado con los e2e:** simulan entrantes con el webhook firmado (`e2e/helpers.ts`, `inbound`).
    Cada corrida suma conversaciones "Prueba …" con números inventados en Cerámicos Demo.

### Producción (pendiente: se configura con el despliegue)

Front y API van **en el mismo dominio** detrás de Caddy: Caddy sirve los archivos de `apps/web/dist/web/browser`
y reenvía `/api/*` a la API, que escucha solo en `127.0.0.1`. Así se mantiene el mismo origen, la cookie
`SameSite=Lax` alcanza y no hace falta CORS. `TRUSTED_ORIGINS` = la URL pública (`https://…`).

Esbozo, a validar al configurar el servidor:

```caddy
panel.ejemplo.com {
  # Tiempo real (tarea 025): el stream SSE va antes que el resto y SIN encode (gzip junta los bytes y
  # retrasa los eventos). flush_interval -1: cada evento sale al instante (Caddy ya lo hace solo con
  # text/event-stream, pero queda explícito). stream_close_delay: al recargar la configuración, los
  # streams abiertos siguen 5 minutos en vez de cortarse todos a la vez (el panel reconectaría en masa).
  # Sin read/write_timeout en el servidor: el latido de la API (25 s) mantiene viva la conexión y queda
  # por debajo de cualquier timeout de inactividad de un proxy intermedio.
  @events path /api/events
  handle @events {
    reverse_proxy 127.0.0.1:3000 {
      flush_interval -1
      stream_close_delay 5m
    }
  }
  handle /api/* {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
  }
  handle {
    encode zstd gzip
    root * /srv/panel
    try_files {path} /index.html
    file_server
  }
  header {
    Content-Security-Policy "<la de abajo>"
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "same-origin"
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    -Server
  }
}
```

**Política de seguridad de contenido (CSP) propuesta:**

```
default-src 'self';
script-src 'self' 'sha256-s5TDGwStH9aoB5WkkQO1ZsRPTmFQKvQEJulfP/3g77A=';
style-src 'self' 'nonce-{NONCE}';
font-src 'self';
img-src 'self' data:;
connect-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

- `script-src`: solo los archivos propios y el script en línea que aplica el tema antes de pintar
  (`apps/web/src/index.html`), por su hash. **Si se cambia ese script, hay que recalcular el hash** sobre el
  `index.html` del build de producción. El build no genera otros scripts en línea (`inlineCritical: false`).
- `style-src`: Angular y la CDK insertan `<style>` en tiempo de ejecución para los estilos de componentes.
  Para no abrir `'unsafe-inline'`, la propuesta es un nonce por pedido: Caddy lo genera (plantilla sobre
  `index.html`), lo pone en la CSP y en `<app-root ngCspNonce="…">`, y Angular lo usa en cada `<style>`. Si al
  configurar Caddy esto no resulta práctico, la alternativa es `style-src 'self' 'unsafe-inline'`: los scripts
  siguen restringidos, que es lo que importa contra XSS.
- `connect-src 'self'`: la API está en el mismo origen. Si después se sirven archivos desde Cloudflare R2,
  agregar su dominio en `img-src`.
