import { ChangeDetectionStrategy, Component, inject, input, signal, type OnInit } from '@angular/core';
import { Router } from '@angular/router';
import type { MeTenantOption } from '@ventas/shared/auth';
import { Check, ChevronRight, CircleAlert, Store } from 'lucide';
import { AuthService } from '../../core/auth/auth.service';
import { safeRedirect } from '../../core/auth/safe-redirect';
import { homePathFor } from '../../core/nav';
import { Button } from '../../ui/button';
import { BrandMark } from '../../ui/brand-mark';
import { Icon } from '../../ui/icon';
import { ROLE_LABELS } from '../../core/roles';
import { Spinner } from '../../ui/spinner';

@Component({
  selector: 'app-choose-tenant-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BrandMark, Icon, Button, Spinner],
  host: { class: 'flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center sm:py-16' },
  template: `
    <main class="w-full max-w-md">
      <div class="card px-5 py-7 sm:px-8 sm:py-9 sm:shadow-2">
        <app-brand-mark />
        <h1 class="mt-6 text-2xl">Elegí una empresa</h1>
        <p class="mt-1 text-sm text-muted">
          Tenés acceso a más de una. Después podés cambiar desde el menú de arriba.
        </p>

        @if (loading()) {
          <p class="flex items-center gap-2 mt-6 text-sm text-muted" role="status">
            <app-spinner /> Cargando empresas…
          </p>
        } @else {
          <ul class="mt-6 flex flex-col gap-2" aria-label="Empresas">
            @for (tenant of tenants(); track tenant.id) {
              <li>
                <button
                  type="button"
                  class="group flex w-full items-center gap-3 rounded-md border border-border bg-surface px-4 py-3 text-left hover:border-primary hover:bg-primary-soft disabled:opacity-60"
                  [disabled]="pendingId() !== null"
                  (click)="choose(tenant)"
                >
                  <span
                    class="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted group-hover:bg-surface group-hover:text-primary"
                  >
                    <app-icon [icon]="storeIcon" />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-semibold text-text">{{ tenant.name }}</span>
                    <span class="text-sm text-muted">{{ roleLabel(tenant) }}</span>
                  </span>
                  @if (pendingId() === tenant.id) {
                    <span class="text-sm text-muted">Entrando…</span>
                  } @else if (currentId() === tenant.id) {
                    <app-icon [icon]="checkIcon" class="text-primary" label="Empresa actual" />
                  } @else {
                    <app-icon [icon]="chevronIcon" class="text-subtle" />
                  }
                </button>
              </li>
            } @empty {
              <li class="text-sm text-muted">No tenés empresas activas.</li>
            }
          </ul>
        }

        @if (error()) {
          <p
            class="mt-4 flex items-start gap-2 rounded-md bg-error-soft px-3 py-2.5 text-sm font-medium text-error"
            role="alert"
          >
            <app-icon [icon]="alertIcon" [size]="16" class="mt-0.5" />
            {{ error() }}
          </p>
        }

        <div class="mt-6 border-t border-border pt-4">
          <button appButton variant="ghost" size="sm" type="button" (click)="signOut()">Cerrar sesión</button>
        </div>
      </div>
    </main>
  `,
})
export class ChooseTenantPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly redirect = input<string>();

  protected readonly tenants = this.auth.tenants;
  protected readonly loading = signal(true);
  protected readonly pendingId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly currentId = () => this.auth.tenant()?.id ?? null;
  protected readonly storeIcon = Store;
  protected readonly checkIcon = Check;
  protected readonly chevronIcon = ChevronRight;
  protected readonly alertIcon = CircleAlert;

  async ngOnInit() {
    try {
      await this.auth.loadTenants();
    } catch {
      this.error.set('No pudimos cargar tus empresas. Probá de nuevo en un momento.');
    } finally {
      this.loading.set(false);
    }
  }

  protected roleLabel(tenant: MeTenantOption) {
    return ROLE_LABELS[tenant.role];
  }

  protected async choose(tenant: MeTenantOption) {
    this.pendingId.set(tenant.id);
    this.error.set(null);
    try {
      // Si ya hay una empresa activa (vino a cambiar), recarga entera para no arrastrar estado.
      if (this.auth.status() === 'ready') {
        if (!(await this.auth.switchTenant(tenant.id))) this.error.set('No pudimos entrar a esa empresa.');
        return;
      }
      if (!(await this.auth.activateTenant(tenant.id))) {
        this.error.set('No pudimos entrar a esa empresa.');
        return;
      }
      const redirect = safeRedirect(this.redirect());
      await this.router.navigateByUrl(redirect === '/' ? homePathFor(this.auth.role()) : redirect, {
        replaceUrl: true,
      });
    } finally {
      this.pendingId.set(null);
    }
  }

  protected signOut() {
    void this.auth.signOut();
  }
}
