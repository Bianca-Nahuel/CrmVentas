---
paths: ["apps/api/**"]
---
- NestJS por módulos: `whatsapp`, `messaging`, `leads`, `ai`, `catalog`, `tenants`, `auth`, `jobs`.
- Cada request autenticado corre en una transacción que setea `SET LOCAL app.tenant_id` y `app.user_id` antes de cualquier consulta.
- Todo input validado con DTOs/schemas. Nada de SQL concatenado.
- Trabajo pesado (IA, importaciones, envíos) siempre en jobs de pg-boss, nunca dentro del request.
- Configuración desde variables de entorno validadas al arrancar; si falta una, la app no levanta.
- Logs estructurados sin datos personales (ni teléfonos, ni nombres, ni texto de mensajes).
