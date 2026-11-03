import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LoaderCircle } from 'lucide';
import { Icon } from './icon';

/**
 * Ruedita de carga que gira. Decorativa (aria-hidden): el texto de al lado ("Cargando…", "Guardando…") es
 * lo que se anuncia. Con "reducir movimiento" el giro se apaga (styles.css).
 *   <p class="flex items-center gap-2"><app-spinner /> Cargando…</p>
 */
@Component({
  selector: 'app-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'inline-flex shrink-0 animate-spin' },
  template: `<app-icon [icon]="icon" [size]="size()" />`,
})
export class Spinner {
  readonly size = input(16);
  protected readonly icon = LoaderCircle;
}
