import type { TenantRole } from '@ventas/shared/auth';

export const ROLE_LABELS: Record<TenantRole, string> = {
  owner: 'Dueño',
  admin: 'Administrador',
  seller: 'Vendedor',
  viewer: 'Solo lectura',
};
