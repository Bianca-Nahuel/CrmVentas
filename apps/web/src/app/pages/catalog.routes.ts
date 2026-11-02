import type { Routes } from '@angular/router';
import { CatalogPage } from './catalog/catalog-page';
import { CatalogSettings } from './catalog/catalog-settings';
import { ImportWizard } from './catalog/import-wizard';
import { ImportsHistory } from './catalog/imports-history';
import { ProductsTab } from './catalog/products-tab';

// Catálogo (tarea 027) en su propio módulo lazy, con una ruta hija por pestaña. La configuración arrastra el
// zod del catálogo (@ventas/shared/ai): no entra en el bundle inicial.
export const CATALOG_ROUTES: Routes = [
  {
    path: '',
    component: CatalogPage,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'productos' },
      { path: 'productos', title: 'Catálogo · Productos', component: ProductsTab },
      { path: 'importar', title: 'Catálogo · Importar', component: ImportWizard },
      { path: 'historial', title: 'Catálogo · Historial', component: ImportsHistory },
      { path: 'configuracion', title: 'Catálogo · Configuración', component: CatalogSettings },
    ],
  },
];
