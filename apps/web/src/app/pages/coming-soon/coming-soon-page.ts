import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Hourglass } from 'lucide';
import type { NavItem } from '../../core/nav';
import { Icon } from '../../ui/icon';

/** Página provisoria de cada sección hasta que tenga su tarea (011–014). */
@Component({
  selector: 'app-coming-soon-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <h1 class="text-2xl sm:text-[28px] sm:leading-[34px]">{{ section().label }}</h1>
    <div class="card mt-5 flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:p-6">
      <span
        class="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-strong"
      >
        <app-icon [icon]="section().icon" [size]="22" />
      </span>
      <div class="flex-1">
        <p class="flex items-center gap-1.5 text-sm font-semibold text-primary-strong">
          <app-icon [icon]="soonIcon" [size]="15" /> Próximamente
        </p>
        <p class="mt-0.5 text-muted">{{ section().soon }}</p>
      </div>
    </div>
  `,
})
export class ComingSoonPage {
  /** Viene de la data de la ruta (withComponentInputBinding). */
  readonly section = input.required<NavItem>();
  protected readonly soonIcon = Hourglass;
}
