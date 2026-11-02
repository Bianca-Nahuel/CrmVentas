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
  // assign: elegir qué vendedores atienden cada número (tarea 014).
  channel: ['read', 'connect', 'disconnect', 'assign'],
  config: ['read', 'update'],
  catalog: ['read', 'import', 'update'],
  // read_all: las conversaciones de todos los números, no solo los asignados.
  lead: ['read', 'read_all', 'update', 'assign'],
  conversation: ['read', 'read_all', 'reply'],
  metrics: ['read'],
  // Consumo y facturación de la empresa (créditos de IA, plan). Solo el owner.
  billing: ['read'],
} as const;

// Tipo explícito: sin él, el .d.ts emitido expande el tipo y deja de ser asignable a AccessControl.
export const ac: AccessControl<typeof statement> = createAccessControl(statement);

const productFull = {
  channel: ['read', 'connect', 'disconnect', 'assign'],
  config: ['read', 'update'],
  catalog: ['read', 'import', 'update'],
  lead: ['read', 'read_all', 'update', 'assign'],
  conversation: ['read', 'read_all', 'reply'],
  metrics: ['read'],
} as const;

export const owner = ac.newRole({
  ...productFull,
  billing: ['read'],
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

// Ve solo las conversaciones de los números que tiene asignados (channel_members), salvo que la empresa
// active inbox.sellers_see_all_channels: eso lo evalúan ConversationScope y la RLS (0015), no este rol.
export const seller = ac.newRole({
  lead: ['read', 'update'],
  conversation: ['read', 'reply'],
  catalog: ['read'],
});

export const viewer = ac.newRole({
  metrics: ['read'],
});

export const tenantRoles = { owner, admin, seller, viewer };

type Statement = typeof statement;
/** Un permiso: { recurso: [acciones] }. */
export type TenantPermission = { [R in keyof Statement]?: Statement[R][number][] };

/**
 * ¿El rol tiene el permiso? La misma regla para la API (que decide) y el panel (que solo oculta).
 * Un rol desconocido no tiene ningún permiso.
 */
export function roleCan(role: string | null | undefined, permission: TenantPermission): boolean {
  if (!role || !Object.hasOwn(tenantRoles, role)) return false;
  const definition = tenantRoles[role as TenantRole];
  return definition.authorize(permission as Parameters<typeof definition.authorize>[0]).success;
}
