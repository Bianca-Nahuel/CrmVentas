# Spec: autenticación, sesiones y empresas

## Problema
Las personas que usan el panel (dueños, administradores, vendedores) tienen que iniciar sesión, pertenecer
a una o más empresas con un rol, y ver **solo** los datos de la empresa activa. El dueño tiene que poder
invitar a sus vendedores y darlos de baja con efecto inmediato.

Los clientes finales que escriben por WhatsApp **no** usan esto: no tienen cuenta ni entran al panel.

## Decisión
Usar **Better Auth** dentro del backend NestJS, con el plugin de **organizaciones**, guardando todo en
nuestro Postgres. Sesiones en base de datos (no JWT) para que cerrar una sesión tenga efecto inmediato.

## Métodos de inicio de sesión
- **MVP:** email + contraseña.
- **Después:** Google. (No implementar ahora, pero no cerrar la puerta: la tabla `accounts` ya lo soporta.)
- Verificación de email y recuperación de contraseña: requieren envío de emails; se dejan configuradas pero
  desactivadas hasta tener proveedor de email (Resend o Brevo).

## Tablas (nombres propios, mapeados desde Better Auth)

| Better Auth | Nuestra tabla | Notas |
|---|---|---|
| `user` | `users` | Global. Columna extra para el administrador de la plataforma (plugin admin: `role`) |
| `session` | `sessions` | Incluye la empresa activa (`active_organization_id` → renombrar a `active_tenant_id` si el plugin lo permite) |
| `account` | `accounts` | Hash de la contraseña y cuentas de proveedores (Google) |
| `verification` | `verifications` | Tokens temporales |
| `organization` | `tenants` | Columnas extra nuestras: `industry`, `timezone`, `status` |
| `member` | `memberships` | Columna extra: `status` (`active`, `disabled`) |
| `invitation` | `invitations` | Invitaciones por email con rol y vencimiento |

- IDs: UUID (`advanced.database.generateId: "uuid"`), con default `uuidv7()` en Postgres.
- Columnas en `snake_case` (mapear los campos de Better Auth).

## Usuarios de base y RLS

Better Auth necesita leer sus tablas antes de conocer la empresa (buscar por email, validar el token), así
que no pueden llevar la RLS por `tenant_id`. Para que un bug del código de negocio nunca pueda leer
contraseñas ni sesiones, se separan los accesos en **tres usuarios de base**:

| Usuario | Lo usa | Acceso |
|---|---|---|
| `ventas_owner` | Migraciones | Dueño de todas las tablas |
| `ventas_auth` | Solo Better Auth (pool de conexiones propio, `DATABASE_URL_AUTH`) | DML sobre `users`, `sessions`, `accounts`, `verifications`, `tenants`, `memberships`, `invitations`. **Ningún permiso** sobre tablas de negocio |
| `ventas_app` | El resto del backend | Tablas de negocio con RLS. **Ningún permiso** sobre `accounts`, `sessions`, `verifications` |

Política por tabla para `ventas_app` (todas con `ENABLE` + `FORCE ROW LEVEL SECURITY`):

| Tabla | Permisos de `ventas_app` | Política |
|---|---|---|
| `accounts`, `sessions`, `verifications` | Ninguno | (no aplica) |
| `memberships` | `SELECT` (+ `UPDATE` de `status`/`role` para `owner`/`admin`, validado en servicios) | `user_id = app.user_id` o `tenant_id = app.tenant_id` |
| `tenants` | `SELECT`, `UPDATE` de columnas propias | `id` en las membresías activas de `app.user_id` |
| `users` | `SELECT` solo de `id`, `name`, `email`, `image` (grant por columnas) | usuarios que comparten alguna empresa con `app.user_id` |
| `invitations` | `SELECT` | `tenant_id = app.tenant_id` |
| Tablas de negocio (tarea 003) | DML mínimo | `tenant_id = app.tenant_id` |

`ventas_auth` no necesita RLS: solo lo usa Better Auth y no tiene acceso a datos de negocio.

**Casos especiales**
- **Webhook de WhatsApp** (tarea 003): sin usuario, primero resuelve la empresa con una función
  `SECURITY DEFINER` que solo devuelve el `tenant_id` de un canal (recibe proveedor + ID externo), y después
  setea `app.tenant_id` y sigue con la RLS activa.
- **Soporte (administrador de la plataforma):** no se desactiva la RLS. El backend verifica el rol y setea
  `app.tenant_id` con la empresa a revisar. Cada acceso de soporte queda registrado en un log de auditoría.

**Regla de implementación:** `SET LOCAL` solo vale dentro de la transacción. Cada request abre **una**
transacción, setea el contexto y todas sus consultas corren en ella. Nunca consultar fuera de esa transacción.

## Roles por empresa

| Rol | Puede |
|---|---|
| `owner` | Todo: configurar la IA y el catálogo, conectar números, invitar y dar de baja usuarios, eliminar la empresa |
| `admin` | Igual que `owner`, salvo eliminar la empresa o cambiar de dueño |
| `seller` | Ver y atender conversaciones y leads (los suyos o todos, según la configuración de la empresa) |
| `viewer` | Solo ver métricas y el embudo |

Además, **administrador de la plataforma** (`users.role = 'admin'` del plugin admin): acceso de soporte a todas las empresas.

Se definen con el sistema de permisos de Better Auth (`createAccessControl`), con recursos como
`channel`, `config`, `catalog`, `lead`, `conversation`, `member`.

## Sesiones
- Duración: 7 días (`expiresIn`), renovación con el uso cada 1 día (`updateAge`).
- Sesión "fresca" (`freshAge`, 1 día) obligatoria para: cambiar contraseña, cambiar email, eliminar la empresa.
- **Caché de cookies desactivado**: cada request valida contra la base, para que una baja sea inmediata.
- Cookie `HttpOnly`, `Secure` en producción y `SameSite=Lax`. Verificar los valores por defecto de la versión instalada.
- Front y API en el **mismo origen**: en desarrollo con el proxy de Angular (`/api` → `localhost:3000`); en producción, Caddy sirve los dos en el mismo dominio.

## Empresa activa y RLS
1. Better Auth valida la cookie y devuelve el usuario y la empresa activa de la sesión.
2. Un guard de NestJS verifica que exista una membresía **activa** de ese usuario en esa empresa.
3. Abre una transacción y ejecuta `SET LOCAL app.tenant_id` y `SET LOCAL app.user_id`.
4. Todas las consultas de negocio corren dentro de esa transacción; la RLS filtra por empresa.
5. Sin empresa activa → solo endpoints que no requieren empresa (perfil, elegir empresa, aceptar invitación).

## Flujos (detalle de pantallas: más adelante, con el panel de Angular)
- **Registro del dueño:** crea usuario + empresa, y queda como `owner`.
- **Invitar vendedor:** `owner`/`admin` invita por email con un rol; el invitado acepta, crea su usuario o usa el que ya tiene.
- **Dar de baja:** desactiva la membresía y revoca sus sesiones en esa empresa.
- **Cambiar de empresa:** si el usuario pertenece a varias, actualiza la empresa activa de la sesión.
- **Logout:** borra la sesión.

## Fuera de alcance de esta spec
- Pantallas de Angular, Google, envío de emails, autenticación de dos factores, SSO empresarial.
- El webhook de WhatsApp: no usa sesiones; identifica la empresa por el canal que recibió el mensaje.

## Criterios de aceptación (para la tarea que la implemente)
- [ ] Registro e inicio de sesión con email y contraseña funcionando por API.
- [ ] La cookie de sesión es `HttpOnly`; sin cookie, los endpoints protegidos responden 401.
- [ ] Logout y revocación tienen efecto inmediato (el request siguiente con el mismo token responde 401).
- [ ] Un usuario sin membresía activa en la empresa activa recibe 403.
- [ ] El contexto `app.tenant_id` queda seteado en cada request protegido (verificable con un endpoint de prueba).
- [ ] Las contraseñas no quedan en texto plano en ninguna tabla ni log.
- [ ] `ventas_app` no puede leer `accounts`, `sessions` ni `verifications` (permission denied).
- [ ] `ventas_auth` no puede leer ninguna tabla de negocio.
- [ ] Con `app.user_id` de un usuario, `ventas_app` solo ve sus empresas, sus membresías y los usuarios con los que comparte empresa.
