import { SetMetadata } from '@nestjs/common';
import type { TenantPermission } from '@ventas/shared';

export const PUBLIC_KEY = 'ventas:public';
export const NO_TENANT_KEY = 'ventas:no-tenant';
export const PERMISSION_KEY = 'ventas:permission';

/**
 * Permiso de libs/shared que exige el endpoint, según el rol en la empresa activa. Sin él → 403
 * FORBIDDEN_ROLE. Lo evalúa TenantGuard después de validar la membresía.
 */
export const RequirePermission = (permission: TenantPermission) => SetMetadata(PERMISSION_KEY, permission);

/** Endpoint sin autenticación (no valida sesión ni abre la transacción con contexto). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Endpoint autenticado que no requiere empresa activa (perfil, elegir empresa, aceptar invitación). */
export const NoTenant = () => SetMetadata(NO_TENANT_KEY, true);
