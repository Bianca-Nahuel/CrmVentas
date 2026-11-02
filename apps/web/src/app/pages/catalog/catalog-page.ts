import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

const TABS = [
  { path: 'productos', label: 'Productos' },
  { path: 'importar', label: 'Importar' },
  { path: 'historial', label: 'Historial' },
  { path: 'configuracion', label: 'Configuración' },
] as const;

/**
 * Catálogo (tarea 027, owner y admin): los productos que puede consultar el agente, la importación del
 * Excel en tres pasos, el historial (con "volver a la anterior") y la configuración del catálogo y del
 * extractor de la web. Decide la API (catalog.update en todo).
 */
@Component({
  selector: 'app-catalog-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <h1 class="text-2xl sm:text-[28px] sm:leading-[34px]">Catálogo</h1>
    <p class="mt-1 text-muted">Los productos que el asistente puede consultar, con sus precios y links.</p>
    <nav class="mt-5 border-b border-border" aria-label="Secciones del catálogo">
      <ul class="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        @for (tab of tabs; track tab.path) {
          <li class="shrink-0">
            <a
              [routerLink]="['/catalogo', tab.path]"
              routerLinkActive="border-primary text-primary-strong"
              class="-mb-px flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-semibold text-muted hover:text-text"
            >
              {{ tab.label }}
            </a>
          </li>
        }
      </ul>
    </nav>
    <div class="mt-5">
      <router-outlet />
    </div>
  `,
})
export class CatalogPage {
  protected readonly tabs = TABS;
}
