import type { Routes } from '@angular/router';

// Rutas SOLO de desarrollo. En el build de producción angular.json reemplaza este archivo por
// dev.routes.prod.ts (vacío), así la página de diseño no llega al bundle.
export const DEV_ROUTES: Routes = [
  {
    path: 'dev/diseno',
    title: 'Sistema de diseño',
    loadComponent: () => import('./design-page').then((m) => m.DesignPage),
  },
];
