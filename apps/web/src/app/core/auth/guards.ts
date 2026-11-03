import { inject } from '@angular/core';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';
import { NotifyService } from '../../ui/toast';
import { can, homePathFor, type Permission } from '../nav';
import { AuthService } from './auth.service';
import { safeRedirect } from './safe-redirect';

// Los guards solo ocultan pantallas: los permisos de verdad los aplica la API en cada pedido.
// Todo inject() va antes del primer await: después ya no hay contexto de inyección.

/**
 * Con sesión. Sin sesión → login con la ruta interna a la que iba. Una sesión con la empresa activa
 * bloqueada (forbidden) sigue siendo sesión: puede elegir otra empresa; el panel lo corta tenantGuard.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const notify = inject(NotifyService);
  const status = await auth.ensureLoaded();
  if (status === 'anonymous') return loginTree(router, state.url);
  if (status === 'offline') {
    notify.networkError();
    return loginTree(router, state.url);
  }
  return true;
};

/** Con empresa activa. Sin empresa → elegir empresa. */
export const tenantGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const status = await auth.ensureLoaded();
  if (status === 'ready') return true;
  if (status === 'no-tenant') return router.parseUrl('/elegir-empresa');
  return router.parseUrl('/sin-acceso');
};

/** Con el permiso de libs/shared para el rol activo. Si no → sin acceso. */
export function permissionGuard(permission: Permission): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    return can(auth.role(), permission) ? true : inject(Router).parseUrl('/sin-acceso');
  };
}

/**
 * Ruta vacía del panel → primera sección permitida (el viewer, a Rendimiento). Es un guard y no un
 * redirectTo porque los redirects se evalúan antes que los guards, cuando el rol todavía no se cargó.
 */
export const homeGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ensureLoaded();
  return router.parseUrl(homePathFor(auth.role()));
};

/** El login solo sin sesión: con sesión y empresa va directo al panel. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const status = await auth.ensureLoaded();
  if (status === 'ready') return router.parseUrl(homePathFor(auth.role()));
  if (status === 'no-tenant') return router.parseUrl('/elegir-empresa');
  return true;
};

function loginTree(router: Router, url: string): UrlTree {
  const redirect = safeRedirect(url);
  return router.createUrlTree(['/ingresar'], { queryParams: redirect === '/' ? {} : { redirect } });
}
