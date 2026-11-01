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

export const NO_TRANSACTION_KEY = 'ventas:no-transaction';

/**
 * Endpoint autenticado que NO corre dentro de la transacción del request: un stream de larga duración
 * (SSE) dejaría una conexión de la base tomada mientras está abierto. El guard valida igual; el handler
 * abre sus propias transacciones cortas con withTenantTransaction.
 */
export const NoTransaction = () => SetMetadata(NO_TRANSACTION_KEY, true);
