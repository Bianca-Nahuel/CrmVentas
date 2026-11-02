import type { Routes } from '@angular/router';
import { permissionGuard } from '../core/auth/guards';
import { PerformancePage } from './performance/performance-page';
import { ReviewPage } from './performance/review-page';

// Rendimiento (tarea 026) en su propio módulo lazy: no comparte páginas con la bandeja. La revisión pide
// performance.read_detail (en la API y en el guard: el viewer que escribe la URL va a "sin acceso").
export const PERFORMANCE_ROUTES: Routes = [
  { path: '', component: PerformancePage },
  {
    path: 'revisiones/:id',
    title: 'Revisión de calidad',
    canActivate: [permissionGuard({ performance: ['read_detail'] })],
    component: ReviewPage,
  },
];
