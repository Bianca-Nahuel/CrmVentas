---
name: migracion-db
description: Convenciones para crear o modificar tablas, índices, políticas RLS y permisos en Postgres. Usar en cualquier tarea que toque el esquema de la base de datos.
---

# Migraciones de base de datos

## Reglas
- Toda modificación del esquema es una **migración versionada nueva**. Nunca edites una migración ya aplicada; nunca cambies la base a mano.
- Las migraciones corren con `ventas_owner` (`DATABASE_URL_MIGRATIONS`). La app usa `ventas_app` (`DATABASE_URL`).
- Cada migración tiene que poder correrse en una base vacía de punta a punta.

## Plantilla para una tabla de negocio
```sql
CREATE TABLE <tabla> (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- columnas...
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON <tabla> (tenant_id /*, columna de orden habitual */);

ALTER TABLE <tabla> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <tabla> FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON <tabla>
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON <tabla> TO ventas_app;  -- solo lo que la app necesita
```

## Tipos y restricciones
- IDs: `uuid` con `uuidv7()`. Fechas: `timestamptz`. Plata: `numeric(p,s)`. Emails: `citext`.
- Estados y enumeraciones: `text` + `CHECK (col IN (...))`, no tipos `ENUM` (son difíciles de migrar).
- Datos flexibles por negocio: `jsonb` con default `'{}'`.
- Idempotencia de mensajes: `UNIQUE (channel_id, external_id)`.
- `updated_at`: trigger compartido que lo actualiza en cada `UPDATE` (crealo una vez y reutilizalo).

## Tablas que no son por tenant
`tenants` y `users` no tienen `tenant_id`; su RLS se basa en `memberships` (el usuario ve lo que comparte con sus empresas). Documentá la política en un comentario.

## Verificación obligatoria de cada migración
1. Corre sin errores sobre la base actual.
2. Conectado como `ventas_app`, **sin** `SET app.tenant_id`, un `SELECT` de la tabla devuelve 0 filas.
3. Con dos tenants de prueba: con `app.tenant_id` = A no se ven ni se pueden modificar filas de B, y un `INSERT` con `tenant_id` de B falla.
4. `ventas_app` no puede hacer `DROP`/`ALTER` de la tabla.
5. Los datos de prueba se borran al final (con `ventas_owner`).
