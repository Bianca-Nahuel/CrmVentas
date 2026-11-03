import type { Routes } from '@angular/router';
import { FunnelPage } from './funnel/funnel-page';

// Embudo de ventas (tarea 028) en su propio módulo lazy. El permiso (metrics.read) lo pide la ruta de
// app.routes.ts; las listas de leads, además, lead.read (en la API y en la página).
export const FUNNEL_ROUTES: Routes = [{ path: '', component: FunnelPage }];
