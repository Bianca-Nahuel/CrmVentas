import type { Routes } from '@angular/router';
import { authGuard, guestGuard, homeGuard, permissionGuard, tenantGuard } from './core/auth/guards';
import { NAV_ITEMS } from './core/nav';
import { DEV_ROUTES } from './dev/dev.routes';
import { Shell } from './pages/layout/shell';

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
      // Al entrar: la primera sección que el rol puede ver (el viewer va a Métricas).
      { path: '', pathMatch: 'full', canActivate: [homeGuard], children: [] },
      ...NAV_ITEMS.map((item) => ({
        path: item.path,
        title: item.label,
        canActivate: [permissionGuard(item.permission)],
        data: { section: item },
        loadComponent: () => import('./pages/coming-soon/coming-soon-page').then((m) => m.ComingSoonPage),
      })),
    ],
  },
  { path: '**', redirectTo: '' },
];
