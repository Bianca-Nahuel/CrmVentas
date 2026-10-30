import { BreakpointObserver } from '@angular/cdk/layout';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import { ChangeDetectionStrategy, Component, inject, type TemplateRef, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterOutlet } from '@angular/router';
import { Menu, X } from 'lucide';
import { map } from 'rxjs';
import { BrandMark } from '../../ui/brand-mark';
import { Icon } from '../../ui/icon';
import { SideNav } from './side-nav';
import { TenantSwitcher } from './tenant-switcher';
import { UserMenu } from './user-menu';

const DESKTOP = '(min-width: 1024px)';

/**
 * Layout del panel: barra lateral fija en escritorio; en el celular, menú ☰ que abre un cajón (diálogo
 * de la CDK: atrapa el foco, se cierra con Esc y devuelve el foco al botón).
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, BrandMark, Icon, SideNav, TenantSwitcher, UserMenu],
  host: { class: 'flex min-h-dvh' },
  template: `
    <a
      href="#contenido"
      class="sr-only z-50 rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >Saltar al contenido</a
    >

    @if (isDesktop()) {
      <aside
        class="sticky top-0 flex h-dvh w-[var(--sidebar-width)] shrink-0 flex-col border-r border-border bg-surface px-3 py-4"
      >
        <div class="px-3 pb-5"><app-brand-mark /></div>
        <app-side-nav />
      </aside>
    }

    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur sm:px-5"
      >
        @if (!isDesktop()) {
          <button
            type="button"
            class="flex size-11 shrink-0 items-center justify-center rounded-md text-text hover:bg-surface-2"
            aria-label="Abrir menú"
            aria-haspopup="dialog"
            data-testid="open-nav"
            (click)="openDrawer()"
          >
            <app-icon [icon]="menuIcon" [size]="22" />
          </button>
        }
        <app-tenant-switcher class="flex-1" />
        <app-user-menu />
      </header>

      <main
        id="contenido"
        tabindex="-1"
        class="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:px-6 lg:py-8"
      >
        <router-outlet />
      </main>
    </div>

    <ng-template #drawer>
      <div
        class="flex h-dvh w-[min(88vw,300px)] flex-col border-r border-border bg-surface px-3 py-4 shadow-3"
        role="navigation"
        aria-label="Menú"
      >
        <div class="flex items-center justify-between pb-5 pl-3">
          <app-brand-mark />
          <button
            type="button"
            class="flex size-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
            aria-label="Cerrar menú"
            (click)="closeDrawer()"
          >
            <app-icon [icon]="closeIcon" [size]="22" />
          </button>
        </div>
        <app-side-nav (navigate)="closeDrawer()" />
      </div>
    </ng-template>
  `,
})
export class Shell {
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);
  private readonly drawerTemplate = viewChild.required<TemplateRef<unknown>>('drawer');
  private drawerRef: DialogRef | null = null;

  protected readonly isDesktop = toSignal(
    inject(BreakpointObserver)
      .observe(DESKTOP)
      .pipe(map((state) => state.matches)),
    { initialValue: globalThis.matchMedia?.(DESKTOP).matches ?? true },
  );

  protected readonly menuIcon = Menu;
  protected readonly closeIcon = X;

  protected openDrawer() {
    this.drawerRef = this.dialog.open(this.drawerTemplate(), {
      ariaLabel: 'Menú',
      hasBackdrop: true,
      backdropClass: 'app-backdrop',
      positionStrategy: this.overlay.position().global().left('0').top('0'),
      height: '100dvh',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    this.drawerRef.closed.subscribe(() => (this.drawerRef = null));
  }

  protected closeDrawer() {
    this.drawerRef?.close();
  }
}
