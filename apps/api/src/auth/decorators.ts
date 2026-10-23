import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'ventas:public';
export const NO_TENANT_KEY = 'ventas:no-tenant';

/** Endpoint sin autenticación (no valida sesión ni abre la transacción con contexto). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Endpoint autenticado que no requiere empresa activa (perfil, elegir empresa, aceptar invitación). */
export const NoTenant = () => SetMetadata(NO_TENANT_KEY, true);
