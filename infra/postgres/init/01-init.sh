#!/usr/bin/env bash
# Inicialización de la base. Corre UNA sola vez, cuando el volumen de datos está vacío.
# Se ejecuta como POSTGRES_USER (el dueño, DB_OWNER_USER).
# Las contraseñas se leen de variables de entorno; nunca se escriben acá.
set -euo pipefail

: "${DB_APP_USER:?Falta DB_APP_USER}"
: "${DB_APP_PASSWORD:?Falta DB_APP_PASSWORD}"
: "${DB_AUTH_USER:?Falta DB_AUTH_USER}"
: "${DB_AUTH_PASSWORD:?Falta DB_AUTH_PASSWORD}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v owner="$POSTGRES_USER" \
  -v db="$POSTGRES_DB" \
  -v app_user="$DB_APP_USER" \
  -v app_password="$DB_APP_PASSWORD" \
  -v auth_user="$DB_AUTH_USER" \
  -v auth_password="$DB_AUTH_PASSWORD" <<'EOSQL'
-- 1. Extensiones
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Rol de la aplicación: puede loguearse, sin ningún privilegio especial.
--    Sin BYPASSRLS y nunca dueño de tablas: la RLS siempre se le aplica.
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT',
  :'app_user', :'app_password'
) \gexec

-- 2b. Rol de Better Auth: mismas restricciones que la aplicación. Solo lo usa el pool de autenticación
--     (DATABASE_URL_AUTH). Recibe DML únicamente sobre las tablas de autenticación, con grants explícitos
--     en su migración; NO tiene privilegios por defecto, así que nunca ve tablas de negocio.
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT',
  :'auth_user', :'auth_password'
) \gexec

-- 3. Acceso a la base y al schema public
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db', :'app_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db', :'auth_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'auth_user') \gexec

-- 4. Privilegios por defecto sobre lo que cree el dueño en el futuro (solo para la aplicación).
--    Las tablas de autenticación los revocan en su migración y dan permisos exactos.
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'owner', :'app_user'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
  :'owner', :'app_user'
) \gexec
EOSQL
