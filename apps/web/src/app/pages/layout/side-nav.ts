import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { InboxSummary } from '../../core/inbox-summary';
import { navFor } from '../../core/nav';
import { Icon } from '../../ui/icon';

/** Navegación principal: solo las secciones que el rol puede ver (la API igual valida cada pedido). */
@Component({
  selector: 'app-side-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, Icon],
  template: `
    <nav aria-label="Secciones">
      <ul class="flex flex-col gap-0.5">
        @for (item of items(); track item.path) {
          <li>
            <a
              class="relative flex min-h-11 items-center gap-3 rounded-md px-3 text-[15px] font-medium text-muted hover:bg-surface-2 hover:text-text"
              [routerLink]="'/' + item.path"
              routerLinkActive="!bg-primary-soft !text-primary-strong font-semibold nav-active"
              ariaCurrentWhenActive="page"
              (click)="navigate.emit()"
            >
              <app-icon [icon]="item.icon" [size]="19" />
              <span class="truncate">{{ item.label }}</span>
              @if (item.path === 'leads' && pending() > 0) {
                <span
                  class="tabular ml-auto rounded-full bg-warning-soft px-2 text-xs font-bold text-warning"
                  data-testid="pending-handoffs"
                  ><span aria-hidden="true">{{ pending() }}</span
                  ><span class="sr-only">, {{ pendingText() }}</span></span
                >
              }
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
  styles: `
    .nav-active::before {
      content: '';
      position: absolute;
      inset-block: 8px;
      left: 0;
      width: 3px;
      border-radius: 0 3px 3px 0;
      background: var(--primary);
    }
  `,
})
export class SideNav {
  private readonly auth = inject(AuthService);
  /** Se eligió una sección (el cajón del celular se cierra). */
  readonly navigate = output();
  protected readonly items = computed(() => navFor(this.auth.role()));
  protected readonly pending = inject(InboxSummary).pendingHandoffs;
  protected readonly pendingText = computed(() =>
    this.pending() === 1 ? '1 derivada sin atender' : `${this.pending()} derivadas sin atender`,
  );
}
