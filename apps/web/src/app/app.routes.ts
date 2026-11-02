import type { Route, Routes } from '@angular/router';
import { authGuard, guestGuard, homeGuard, permissionGuard, tenantGuard } from './core/auth/guards';
import { NAV_ITEMS } from './core/nav';
import { DEV_ROUTES } from './dev/dev.routes';
import { Shell } from './pages/layout/shell';

// Secciones que ya tienen su pantalla: las de la bandeja (tareas 014 y 011) en un mismo módulo lazy (ver
// inbox.routes.ts) y Rendimiento (026) en el suyo.
// El resto muestra "próximamente".
const SECTIONS: Record<string, Pick<Route, 'loadChildren'>> = {
  leads: { loadChildren: () => import('./pages/inbox.routes').then((m) => m.LEADS_ROUTES) },
  conversaciones: { loadChildren: () => import('./pages/inbox.routes').then((m) => m.INBOX_ROUTES) },
  numeros: { loadChildren: () => import('./pages/inbox.routes').then((m) => m.CHANNELS_ROUTES) },
  rendimiento: { loadChildren: () => import('./pages/performance.routes').then((m) => m.PERFORMANCE_ROUTES) },
};
const comingSoon = () => import('./pages/coming-soon/coming-soon-page').then((m) => m.ComingSoonPage);

export const routes: Routes = [
  {
    path: 'ingresar',
    title: 'Ingresar',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/login/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'elegir-empresa',
    title: 'Elegir empresa',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/choose-tenant/choose-tenant-page').then((m) => m.ChooseTenantPage),
  },
  {
    path: 'sin-acceso',
    title: 'Sin acceso',
    loadComponent: () => import('./pages/no-access/no-access-page').then((m) => m.NoAccessPage),
  },
  ...DEV_ROUTES,
  {
    path: '',
    component: Shell,
    canActivate: [authGuard, tenantGuard],
    children: [
      // Al entrar: la primera sección que el rol puede ver (el viewer va a Rendimiento).
      { path: '', pathMatch: 'full', canActivate: [homeGuard], children: [] },
      // Canales se unificó con Números y vendedores: los links viejos van a Números.
      { path: 'canales', redirectTo: 'numeros' },
      ...NAV_ITEMS.map((item) => ({
        path: item.path,
        title: item.label,
        canActivate: [permissionGuard(item.permission)],
        data: { section: item },
        ...(SECTIONS[item.path] ?? { loadComponent: comingSoon }),
      })),
    ],
  },
  { path: '**', redirectTo: '' },
];
