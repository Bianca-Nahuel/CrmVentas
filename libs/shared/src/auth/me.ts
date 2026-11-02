// Respuestas de /api/me/* que consume el panel. Hasta que la API exponga OpenAPI (tarea 014), los tipos
// de las respuestas viven acá para que backend y frontend no se desalineen.
import type { TenantRole } from './permissions.js';

export interface MeUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface MeTenant {
  id: string;
  name: string;
  slug: string;
}

/** GET /api/me/context: la empresa activa de la sesión y el rol del usuario en ella. */
export interface MeContext {
  user: MeUser;
  tenant: MeTenant & { industry: string; timezone: string };
  role: TenantRole;
}

/** GET /api/me/tenants: empresas activas donde el usuario tiene una membresía activa. */
export interface MeTenantOption extends MeTenant {
  role: TenantRole;
}

/** Códigos de los 403 del TenantGuard. */
export const ME_ERROR_CODES = {
  noActiveTenant: 'NO_ACTIVE_TENANT',
  membershipInactive: 'MEMBERSHIP_INACTIVE',
  tenantSuspended: 'TENANT_SUSPENDED',
  originNotAllowed: 'ORIGIN_NOT_ALLOWED',
} as const;
