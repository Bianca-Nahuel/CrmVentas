// Tablas de autenticación y empresas (Better Auth + plugins organization y admin).
// Partió del `generate` del CLI de Better Auth y se ajustó a docs/specs/autenticacion.md:
// nombres propios de tablas, columnas snake_case, UUID con default uuidv7() en la base
// (con generateId: 'uuid' y Postgres, Better Auth deja que el ID lo ponga la base).
//
// Las claves JS de cada columna son los nombres de campo que usa Better Auth (el adaptador de
// Drizzle busca por clave). organizationId → tenantId y activeOrganizationId → activeTenantId
// están mapeados en auth.ts con `schema.*.fields`.
//
// Permisos, RLS y CHECKs de valores: migración 0001 (SQL a mano).
import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: id(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Plugin admin: rol de plataforma ('admin' = soporte), no el rol dentro de una empresa.
    role: text('role').notNull().default('user'),
    banned: boolean('banned').notNull().default(false),
    banReason: text('ban_reason'),
    banExpires: timestamp('ban_expires', { withTimezone: true }),
  },
  (t) => [
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_role_check', sql`${t.role} IN ('user', 'admin')`),
  ],
);

export const tenants = pgTable(
  'tenants',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    logo: text('logo'),
    metadata: text('metadata'),
    createdAt: createdAt(),
    // Columnas nuestras (additionalFields en auth.ts, salvo updatedAt que lo mantiene el trigger)
    updatedAt: updatedAt(),
    industry: text('industry').notNull(),
    timezone: text('timezone').notNull(),
    status: text('status').notNull().default('active'),
  },
  (t) => [check('tenants_status_check', sql`${t.status} IN ('active', 'suspended')`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Plugin admin. La suplantación está desactivada (disabledPaths): siempre NULL.
    impersonatedBy: uuid('impersonated_by').references(() => users.id, { onDelete: 'set null' }),
    // Plugin organization: empresa activa de la sesión.
    activeTenantId: uuid('active_tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    // Hash scrypt (salt:hash). Nunca texto plano.
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('accounts_user_id_idx').on(t.userId)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

const tenantRoleCheck = (column: unknown) => sql`${column} IN ('owner', 'admin', 'seller', 'viewer')`;

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Nuestra: una membresía 'disabled' no da acceso (TenantGuard y hook de auth.ts).
    status: text('status').notNull().default('active'),
  },
  (t) => [
    unique('memberships_tenant_user_unique').on(t.tenantId, t.userId),
    index('memberships_user_id_idx').on(t.userId),
    check('memberships_role_check', tenantRoleCheck(t.role)),
    check('memberships_status_check', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    index('invitations_tenant_id_idx').on(t.tenantId),
    index('invitations_email_idx').on(t.email),
    check('invitations_role_check', tenantRoleCheck(t.role)),
    check('invitations_status_check', sql`${t.status} IN ('pending', 'accepted', 'rejected', 'canceled')`),
  ],
);

// Claves = nombres de modelo configurados en auth.ts (modelName).
export const authSchema = { users, sessions, accounts, verifications, tenants, memberships, invitations };
