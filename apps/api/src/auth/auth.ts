// Configuración de Better Auth. Ver docs/specs/autenticacion.md.
// No depende de Nest: la usan también el seed y los tests.
import { ac as tenantAc, tenantRoles } from '@ventas/shared';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { admin, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements as adminStatements } from 'better-auth/plugins/admin/access';
import type { Env } from '../config/env.js';
import type { AuthDb } from '../db/pools.js';
import { authSchema } from '../db/schema/auth.js';

const DAY = 60 * 60 * 24;

// Rutas de organización que un miembro desactivado igual puede usar: no actúan sobre una empresa
// concreta en nombre de su membresía (listar las propias, responder invitaciones, chequear un slug).
const ORG_PATHS_WITHOUT_MEMBERSHIP_CHECK = new Set([
  '/organization/list',
  '/organization/list-user-invitations',
  '/organization/get-invitation',
  '/organization/accept-invitation',
  '/organization/reject-invitation',
  '/organization/check-slug',
]);

// Suplantación de usuarios del plugin admin: desactivada por ahora.
const DISABLED_PATHS = ['/admin/impersonate-user', '/admin/stop-impersonating'];

// Administrador de la plataforma (soporte): todos los permisos del plugin admin salvo suplantar.
const platformAc = createAccessControl(adminStatements);
const platformRoles = {
  admin: platformAc.newRole({
    user: ['create', 'list', 'set-role', 'ban', 'delete', 'set-password', 'set-email', 'get', 'update'],
    session: ['list', 'revoke', 'delete'],
  }),
  user: platformAc.newRole({ user: [], session: [] }),
};

function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Campos con los que los endpoints de organización reciben la empresa objetivo (body o query).
const ORG_TARGET_KEYS = ['organizationId', 'organizationSlug'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Una membresía desactivada no puede operar sobre su empresa a través de /api/auth/organization/*
// (invitar, cambiar roles, sacar miembros, editar o borrar la empresa, activarla en la sesión).
// Los endpoints del plugin no conocen nuestro `status`, así que se corta acá, antes del handler.
const rejectDisabledMemberships = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith('/organization/') || ORG_PATHS_WITHOUT_MEMBERSHIP_CHECK.has(ctx.path)) return;

  const session = await getSessionFromCtx(ctx);
  // Sin sesión: llamada del servidor (seed, tareas internas) o request anónimo, que el endpoint rechaza.
  if (!session) return;

  // Desactivar la empresa activa (organizationId: null) siempre se permite.
  const body = ctx.body as Record<string, unknown> | undefined;
  if (ctx.path === '/organization/set-active' && body?.organizationId === null && !body.organizationSlug)
    return;

  // Cada endpoint del plugin elige la empresa a su manera (algunos priorizan el slug sobre el id y otros
  // aceptan un slug dentro de `organizationId`). Para no depender de ese orden, se resuelven TODOS los
  // valores recibidos, como id o como slug, y se rechaza si cualquiera apunta a una membresía desactivada.
  const candidates = ORG_TARGET_KEYS.flatMap((key) => [
    readString(ctx.body, key),
    readString(ctx.query, key),
  ]).filter((value): value is string => value !== undefined);
  const tenantIds = new Set<string>();
  for (const value of new Set(candidates)) {
    if (UUID_PATTERN.test(value)) tenantIds.add(value.toLowerCase());
    const bySlug = await ctx.context.adapter.findOne<{ id: string }>({
      model: 'organization',
      where: [{ field: 'slug', value }],
    });
    if (bySlug) tenantIds.add(bySlug.id);
  }
  // cancel-invitation (y similares) sacan la empresa de la invitación, no del body.
  const invitationId = readString(ctx.body, 'invitationId') ?? readString(ctx.query, 'invitationId');
  if (invitationId && UUID_PATTERN.test(invitationId)) {
    const invitation = await ctx.context.adapter.findOne<{ organizationId: string }>({
      model: 'invitation',
      where: [{ field: 'id', value: invitationId }],
    });
    if (invitation) tenantIds.add(invitation.organizationId);
  }
  // Sin empresa explícita, los endpoints usan la activa de la sesión.
  if (candidates.length === 0 && !invitationId) {
    const active = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
    if (active) tenantIds.add(active);
  }

  for (const tenantId of tenantIds) {
    const membership = await ctx.context.adapter.findOne<{ status: string }>({
      model: 'member',
      where: [
        { field: 'organizationId', value: tenantId },
        { field: 'userId', value: session.user.id },
      ],
    });
    if (membership && membership.status !== 'active') {
      throw new APIError('FORBIDDEN', {
        code: 'MEMBERSHIP_DISABLED',
        message: 'La membresía está desactivada',
      });
    }
  }
});

export function createAuth(env: Env, db: AuthDb) {
  return betterAuth({
    appName: 'ventas',
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: env.TRUSTED_ORIGINS,
    telemetry: { enabled: false },
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),

    user: { modelName: 'users' },
    account: { modelName: 'accounts' },
    verification: { modelName: 'verifications' },
    session: {
      modelName: 'sessions',
      expiresIn: 7 * DAY,
      updateAge: DAY,
      freshAge: DAY,
      // Desactivado: cada request valida contra la base, así una baja o un logout es inmediato.
      cookieCache: { enabled: false },
    },

    // Verificación de email y recuperación de contraseña: desactivadas hasta tener proveedor de email
    // (sin sendVerificationEmail ni sendResetPassword configurados, esos flujos no envían nada).
    emailAndPassword: { enabled: true, requireEmailVerification: false },

    advanced: {
      database: { generateId: 'uuid' },
      // Secure en producción y siempre que la URL pública sea https (aunque falte NODE_ENV).
      useSecureCookies: env.NODE_ENV === 'production' || env.BETTER_AUTH_URL.startsWith('https://'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },

    disabledPaths: DISABLED_PATHS,
    hooks: { before: rejectDisabledMemberships },

    plugins: [
      organization({
        ac: tenantAc,
        roles: tenantRoles,
        creatorRole: 'owner',
        // Las empresas se crean desde el servidor (alta de cliente, seed), no desde el panel.
        allowUserToCreateOrganization: false,
        teams: { enabled: false },
        schema: {
          organization: {
            modelName: 'tenants',
            additionalFields: {
              industry: { type: 'string', required: true, input: true },
              timezone: { type: 'string', required: true, input: true },
              status: { type: 'string', required: false, input: false, defaultValue: 'active' },
            },
          },
          member: {
            modelName: 'memberships',
            fields: { organizationId: 'tenantId' },
            additionalFields: {
              status: { type: 'string', required: false, input: false, defaultValue: 'active' },
            },
          },
          invitation: {
            modelName: 'invitations',
            fields: { organizationId: 'tenantId' },
          },
          session: {
            fields: { activeOrganizationId: 'activeTenantId' },
          },
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: data }) => {
            if (!isValidTimezone(data.timezone)) {
              throw new APIError('BAD_REQUEST', { message: 'timezone inválida (formato IANA)' });
            }
            if (typeof data.industry !== 'string' || data.industry.trim().length === 0) {
              throw new APIError('BAD_REQUEST', { message: 'industry es obligatorio' });
            }
          },
          beforeUpdateOrganization: async ({ organization: data }) => {
            if (data.timezone !== undefined && !isValidTimezone(data.timezone)) {
              throw new APIError('BAD_REQUEST', { message: 'timezone inválida (formato IANA)' });
            }
            if (
              data.industry !== undefined &&
              (typeof data.industry !== 'string' || data.industry.trim().length === 0)
            ) {
              throw new APIError('BAD_REQUEST', { message: 'industry no puede estar vacío' });
            }
          },
        },
      }),
      admin({
        ac: platformAc,
        roles: platformRoles,
        defaultRole: 'user',
        adminRoles: ['admin'],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
