// Permisos por empresa (plugin de organizaciones de Better Auth).
// Vive en libs/shared para que el backend y el panel de Angular usen exactamente las mismas reglas.
import { createAccessControl, type AccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

export const TENANT_ROLES = ['owner', 'admin', 'seller', 'viewer'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const statement = {
  // Recursos propios de Better Auth (organization, member, invitation, team, ac)
  ...defaultStatements,
  // Recursos del producto
  channel: ['read', 'connect', 'disconnect'],
  config: ['read', 'update'],
  catalog: ['read', 'import', 'update'],
  lead: ['read', 'read_all', 'update', 'assign'],
  conversation: ['read', 'read_all', 'reply'],
  metrics: ['read'],
} as const;

// Tipo explícito: sin él, el .d.ts emitido expande el tipo y deja de ser asignable a AccessControl.
export const ac: AccessControl<typeof statement> = createAccessControl(statement);

const productFull = {
  channel: ['read', 'connect', 'disconnect'],
  config: ['read', 'update'],
  catalog: ['read', 'import', 'update'],
  lead: ['read', 'read_all', 'update', 'assign'],
  conversation: ['read', 'read_all', 'reply'],
  metrics: ['read'],
} as const;

export const owner = ac.newRole({
  ...productFull,
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

// Igual que owner, salvo eliminar la empresa (y cambiar de dueño, que se controla en servicios).
export const admin = ac.newRole({
  ...productFull,
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

// "Los suyos o todos" depende de la configuración de la empresa: read_all se evalúa en servicios.
export const seller = ac.newRole({
  lead: ['read', 'read_all', 'update'],
  conversation: ['read', 'read_all', 'reply'],
  catalog: ['read'],
});

export const viewer = ac.newRole({
  metrics: ['read'],
});

export const tenantRoles = { owner, admin, seller, viewer };
