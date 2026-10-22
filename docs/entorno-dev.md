# Entorno de desarrollo local

Postgres 18 (con pgvector) y WAHA corren en Docker. El backend (NestJS) y el frontend
(Angular) corren en el host, fuera de Docker.

| Servicio | Dirección en el host |
|---|---|
| Postgres | `localhost:5432` |
| WAHA (API, dashboard y Swagger) | `http://localhost:3001` |

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
Las contraseñas de `DB_OWNER_PASSWORD` y `DB_APP_PASSWORD` tienen que coincidir con las
que aparecen dentro de `DATABASE_URL_MIGRATIONS` y `DATABASE_URL`.

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

| Usuario | Para qué | Variable |
|---|---|---|
| `ventas_owner` | Solo migraciones (crear/alterar tablas). | `DATABASE_URL_MIGRATIONS` |
| `ventas_app` | El backend en ejecución, y para probar consultas como las vería la app. | `DATABASE_URL` |

Con psql, sin instalar nada en el host:

```bash
docker compose -f infra/docker-compose.yml exec postgres psql -U ventas_app -d ventas
```

En DBeaver: nueva conexión PostgreSQL con esos datos y la contraseña del `.env`.

## 5. Conectar un número en WAHA

1. Abrí `http://localhost:3001/dashboard` y entrá con `WAHA_DASHBOARD_USERNAME` /
   `WAHA_DASHBOARD_PASSWORD`. Si el dashboard pide la API key, es `WAHA_API_KEY`.
2. Creá una sesión (motor NOWEB) y escaneá el QR desde WhatsApp → Dispositivos vinculados.

**Solo se usa el número de prueba del equipo. Nunca un número personal ni el de un cliente.**

Las llamadas a la API de WAHA llevan el header `X-Api-Key: <WAHA_API_KEY>`.

WAHA envía los webhooks a `WAHA_WEBHOOK_URL` (por defecto
`http://host.docker.internal:3000/webhooks/waha`, o sea, la API NestJS en el host) con
los eventos:

- `message`: mensajes entrantes.
- `message.any`: todos los mensajes, incluidos los propios (`fromMe: true`), por ejemplo
  los que manda el vendedor desde el celular. Los usamos para pausar la IA cuando responde
  un humano.

La sesión queda guardada en un volumen, así que no hay que reescanear el QR en cada reinicio.

## 6. Reiniciar la base desde cero

```bash
docker compose -f infra/docker-compose.yml down -v
docker compose -f infra/docker-compose.yml up -d
```

`down -v` borra **todos** los volúmenes: los datos de Postgres **y las sesiones de WAHA**
(hay que volver a escanear el QR). Al levantar, `infra/postgres/init/01-init.sh` vuelve a
crear las extensiones y el usuario de la aplicación.

## 7. Por qué dos usuarios de base

La RLS (Row Level Security) **no se aplica** a los superusuarios ni al dueño de las tablas.
Si la aplicación se conectara con el usuario dueño, las políticas se ignorarían en silencio
y un cliente podría ver datos de otro. Por eso:

- `ventas_owner`: solo para correr migraciones.
- `ventas_app`: el que usa el backend. Nunca es dueño de tablas y no tiene `BYPASSRLS`
  (tampoco `SUPERUSER`, `CREATEDB` ni `CREATEROLE`).

Gracias a los privilegios por defecto, cada tabla que cree `ventas_owner` en `public` le da
automáticamente a `ventas_app` solo `SELECT, INSERT, UPDATE, DELETE` (y `USAGE, SELECT`
sobre las secuencias). `ventas_app` no puede crear, alterar ni borrar tablas.

**Para las migraciones:** cada tabla de negocio tiene que llevar

```sql
ALTER TABLE <tabla> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <tabla> FORCE ROW LEVEL SECURITY;
```
