# Tarea: crear el entorno de desarrollo local (Postgres + WAHA)

## Contexto

Estamos construyendo un sistema de ventas por WhatsApp con IA y CRM, multi-empresa (multi-tenant).
Stack: backend NestJS, frontend Angular, base PostgreSQL con Row Level Security (RLS), y WAHA
como proveedor de WhatsApp para desarrollo.

En esta tarea **solo** se arma la infraestructura local con Docker Compose. El backend y el
frontend se van a correr fuera de Docker (en el host) para tener recarga rápida.

## Objetivo

Que con un solo comando (`docker compose up -d`) queden funcionando:

1. Un Postgres 18 con las extensiones necesarias y **dos usuarios de base separados**
   (uno dueño de las tablas para migraciones, otro sin privilegios para la aplicación).
2. Un WAHA con el motor NOWEB, listo para conectar un número escaneando un QR y enviar
   webhooks a la API que corre en el host.

## Antes de empezar

1. Revisá la estructura actual del repo y no pises archivos existentes. Si algún archivo de
   esta tarea ya existe, mostrame la diferencia y preguntame antes de reemplazarlo.
2. Verificá que Docker esté instalado (`docker --version` y `docker compose version`).
   Si no está, avisame y frená: no lo instales vos.
3. Consultá la documentación actual de WAHA para confirmar los nombres exactos de las variables
   de entorno del webhook y del motor (pueden haber cambiado). No inventes nombres.

## Archivos a crear

```
infra/
  docker-compose.yml
  postgres/
    init/
      01-init.sh
.env.example
docs/
  entorno-dev.md
```

Además, agregá `.env` al `.gitignore` (crealo si no existe).

## Paso 1: `.env.example`

Plantilla de variables, **sin valores reales**. El archivo `.env` real lo copia cada
desarrollador a partir de este y nunca se commitea.

```dotenv
# Postgres
POSTGRES_DB=ventas
DB_OWNER_USER=ventas_owner
DB_OWNER_PASSWORD=cambiar
DB_APP_USER=ventas_app
DB_APP_PASSWORD=cambiar

# Cadenas de conexión para el backend (host)
DATABASE_URL_MIGRATIONS=postgres://ventas_owner:cambiar@localhost:5432/ventas
DATABASE_URL=postgres://ventas_app:cambiar@localhost:5432/ventas

# WAHA
WAHA_PORT=3001
WAHA_WEBHOOK_URL=http://host.docker.internal:3000/webhooks/waha
```

Después creá un `.env` local copiando `.env.example` y generando contraseñas aleatorias
para desarrollo (por ejemplo con `openssl rand -hex 16`). Actualizá también las dos
`DATABASE_URL` con esas contraseñas.

## Paso 2: `infra/docker-compose.yml`

Requisitos:

- **Postgres**
  - Imagen `pgvector/pgvector:pg18` (Postgres 18 trae `uuidv7()` nativo y la imagen incluye pgvector).
  - `POSTGRES_USER` = el usuario dueño (`DB_OWNER_USER`), con su contraseña desde `.env`.
  - Pasale también `DB_APP_USER` y `DB_APP_PASSWORD` como variables de entorno, porque las usa el script de inicio.
  - Puerto publicado **solo en localhost**: `127.0.0.1:5432:5432`.
  - Volumen con nombre para los datos.
  - Montar `./postgres/init` en `/docker-entrypoint-initdb.d` como solo lectura.
  - `healthcheck` con `pg_isready`.
- **WAHA**
  - Imagen `devlikeapro/waha`.
  - Motor NOWEB (consume menos RAM que el motor con navegador).
  - Webhook apuntando a `WAHA_WEBHOOK_URL`, suscripto a los eventos de mensajes entrantes
    **y también a los mensajes propios** (los que el vendedor manda desde el celular), porque
    los necesitamos para pausar la IA cuando responde un humano.
  - Puerto publicado solo en localhost: `127.0.0.1:${WAHA_PORT}:3000` (3001 en el host para no
    chocar con NestJS, que usa el 3000).
  - `extra_hosts: ["host.docker.internal:host-gateway"]`, para que el webhook llegue al host
    también en Linux.
  - Volumen con nombre para las sesiones, así no hay que reescanear el QR en cada reinicio.
  - Si WAHA soporta una API key, configurala desde `.env` y agregá la variable a `.env.example`.
- Leer las variables desde el `.env` de la raíz del repo (`env_file` o interpolación).

## Paso 3: `infra/postgres/init/01-init.sh`

Script de shell (no `.sql`) para poder leer las variables de entorno. Se ejecuta **una sola vez**,
cuando el volumen de datos está vacío. Tiene que:

1. Crear las extensiones: `citext`, `pg_trgm`, `unaccent`, `vector`.
2. Crear el rol de la aplicación (`DB_APP_USER`) con `LOGIN` y su contraseña, y **sin**
   `SUPERUSER`, `CREATEDB`, `CREATEROLE` ni `BYPASSRLS`.
3. Darle a ese rol: `CONNECT` sobre la base y `USAGE` sobre el schema `public`.
4. Configurar privilegios por defecto para que las tablas que cree el dueño en el futuro
   le den al rol de la aplicación solo `SELECT, INSERT, UPDATE, DELETE`, y `USAGE, SELECT`
   sobre las secuencias:
   `ALTER DEFAULT PRIVILEGES FOR ROLE <dueño> IN SCHEMA public GRANT ... TO <app>;`
5. Usar `set -euo pipefail` y `psql -v ON_ERROR_STOP=1`.
6. No escribir contraseñas en el script: leerlas de las variables de entorno.

### Por qué dos usuarios (importante, no lo simplifiques)

La RLS **no se aplica** a los superusuarios ni al dueño de las tablas. Si la aplicación se
conectara con el usuario dueño, las políticas se ignorarían en silencio y un cliente podría
ver datos de otro. Por eso:

- `ventas_owner`: solo para correr migraciones.
- `ventas_app`: el que usa el backend. Nunca es dueño de tablas y no tiene `BYPASSRLS`.

En las migraciones futuras, cada tabla de negocio va a llevar `ENABLE ROW LEVEL SECURITY`
y `FORCE ROW LEVEL SECURITY`. Eso no es parte de esta tarea, pero dejalo anotado en la doc.

## Paso 4: `docs/entorno-dev.md`

Documentación breve para cualquier desarrollador del equipo, con:

1. Requisitos (Docker Desktop; en Windows, con WSL2).
2. Cómo crear el `.env` a partir de `.env.example`.
3. Cómo levantar y bajar el entorno.
4. Cómo conectarse a la base con DBeaver o psql, aclarando qué usuario usar para qué.
5. Cómo conectar un número en WAHA: abrir `http://localhost:3001`, crear una sesión y escanear
   el QR. Aclarar que **solo se usa el número de prueba**, nunca un número personal ni de un cliente.
6. Cómo reiniciar la base desde cero (`docker compose down -v`), avisando que eso también borra
   las sesiones de WAHA.
7. La explicación de los dos usuarios de base (copiá el "por qué" del Paso 3).

## Paso 5: verificación (obligatoria)

Levantá el entorno y verificá cada punto. Mostrame la salida de cada comando:

1. `docker compose -f infra/docker-compose.yml up -d` termina sin errores.
2. `docker compose -f infra/docker-compose.yml ps` muestra Postgres como `healthy` y WAHA corriendo.
3. Las extensiones existen:
   `SELECT extname FROM pg_extension ORDER BY 1;` → incluye `citext`, `pg_trgm`, `unaccent`, `vector`.
4. `uuidv7()` funciona: `SELECT uuidv7();` devuelve un UUID.
5. El rol de la aplicación está bien configurado:
   `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '<app>';`
   → todas las columnas booleanas en `false`.
6. El usuario de la aplicación puede conectarse con la `DATABASE_URL` del `.env`.
7. Prueba de privilegios por defecto: con el usuario dueño, creá una tabla temporal de prueba;
   con el usuario de la aplicación, verificá que puede hacer `INSERT` y `SELECT` pero **no**
   `DROP TABLE`. Después borrá la tabla de prueba con el usuario dueño.
8. WAHA responde en `http://localhost:3001` (por ejemplo, el endpoint de health o la lista de sesiones).
9. `git status` no muestra el `.env` como archivo a commitear.

Si algún punto falla, corregilo y volvé a verificar. No des la tarea por terminada con una
verificación fallida.

## Fuera de alcance (no lo hagas en esta tarea)

- Crear tablas o migraciones del modelo de datos (es la próxima tarea).
- Crear el proyecto NestJS o Angular.
- Escanear el QR o conectar un número real.
- Instalar Docker o cualquier software en el sistema.
- Exponer puertos fuera de `127.0.0.1`.

## Entregable

Al terminar, resumime en pocas líneas:

- Qué archivos creaste o modificaste.
- El resultado de cada punto de la verificación.
- Cualquier decisión que tomaste y que no estaba en estas instrucciones (por ejemplo,
  nombres de variables de WAHA distintos a los esperados).

## Resultado

Tarea completada. Los 9 puntos de la verificación pasaron:

1. `docker compose -f infra/docker-compose.yml up -d` sin errores.
2. `ps`: Postgres `healthy` y WAHA corriendo.
3. Extensiones `citext`, `pg_trgm`, `unaccent` y `vector` presentes.
4. `uuidv7()` devuelve un UUID.
5. Rol `ventas_app` con `rolsuper`, `rolbypassrls`, `rolcreatedb` y `rolcreaterole` en `false`.
6. `ventas_app` se conecta con la `DATABASE_URL` del `.env`.
7. Privilegios por defecto: `INSERT` y `SELECT` sí, `DROP TABLE` no.
8. WAHA responde en `http://localhost:3001`.
9. `git status` no muestra el `.env`.

Decisiones tomadas que no estaban en las instrucciones:

- **Dos archivos de Compose:** `infra/docker-compose.yml` incluye `infra/servicios.yml` y le pasa el `.env` de la raíz con `env_file: ../.env`, porque por defecto Compose solo lee el `.env` junto al compose file.
- **Variables de WAHA:** nombres según la documentación vigente (motor NOWEB, `WAHA_WEBHOOK_URL`, API key `WAHA_API_KEY`), con los eventos `message` y `message.any`.
- **Usuario del dashboard:** `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD` desde el `.env`.
- **Volumen de Postgres 18:** se ajustó el punto de montaje del volumen al layout de datos de Postgres 18.
- **`NOINHERIT`:** el rol de la aplicación se creó con `NOINHERIT`.
- **`.gitattributes`:** se agregó para fijar los finales de línea (LF) de los scripts de shell.
