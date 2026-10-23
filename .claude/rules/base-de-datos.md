---
paths: ["apps/api/src/db/**", "apps/api/drizzle/**", "**/migrations/**", "infra/postgres/**"]
---
- Seguí el skill `migracion-db` para cualquier cambio de esquema.
- Toda tabla de negocio: `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, política por `app.tenant_id`, grants mínimos a `ventas_app`.
- Nunca editar una migración aplicada. Nunca conectar la app como `ventas_owner`.
- `uuidv7()`, `timestamptz`, `numeric` para plata, `text` + `CHECK` para estados.
