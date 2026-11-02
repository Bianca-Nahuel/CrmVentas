import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ShieldX } from 'lucide';
import { AuthService } from '../../core/auth/auth.service';
import { homePathFor } from '../../core/nav';
import { Button } from '../../ui/button';
import { BrandMark } from '../../ui/brand-mark';
import { Icon } from '../../ui/icon';

/** 403: ruta sin permiso, membresía desactivada o empresa suspendida. No dice cuál (lo sabe el backend). */
@Component({
  selector: 'app-no-access-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BrandMark, Icon, Button, RouterLink],
  host: { class: 'flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center sm:py-16' },
  template: `
    <main class="w-full max-w-md">
      <div class="card px-5 py-7 text-center sm:px-8 sm:py-9 sm:shadow-2">
        <div class="flex justify-center"><app-brand-mark /></div>
        <span
          class="mx-auto mt-6 flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning"
        >
          <app-icon [icon]="icon" [size]="24" />
        </span>
        <h1 class="mt-4 text-2xl">No tenés acceso</h1>
        <p class="mt-2 text-muted">
          Tu usuario no tiene permiso para ver esta sección, o tu acceso a la empresa está desactivado. Si
          creés que es un error, hablá con quien administra el panel en tu empresa.
        </p>
        <div class="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          @if (canGoHome()) {
            <a appButton [routerLink]="homePath()">Volver al inicio</a>
          } @else if (hasOtherTenants()) {
            <a appButton routerLink="/elegir-empresa">Elegir otra empresa</a>
          }
          @if (hasSession()) {
            <button appButton variant="secondary" type="button" (click)="signOut()">Cerrar sesión</button>
          } @else {
            <a appButton variant="secondary" routerLink="/ingresar">Ir al login</a>
          }
        </div>
      </div>
    </main>
  `,
})
export class NoAccessPage {
  private readonly auth = inject(AuthService);
  protected readonly icon = ShieldX;
  protected readonly homePath = computed(() => homePathFor(this.auth.role()));
  protected readonly canGoHome = computed(
    () => this.auth.status() === 'ready' && this.homePath() !== '/sin-acceso',
  );
  protected readonly hasSession = computed(() => !['anonymous', 'unknown'].includes(this.auth.status()));
  /** Membresía desactivada en la empresa activa, pero con otras empresas activas: puede cambiar. */
  protected readonly hasOtherTenants = computed(
    () => this.auth.status() !== 'ready' && this.auth.tenants().length > 0,
  );

  constructor() {
    void this.refresh();
  }

  // Vuelve a consultar (no usa el estado guardado): si reactivaron la membresía, se ve sin recargar.
  private async refresh() {
    const status = await this.auth.load();
    if (status === 'forbidden' || status === 'no-tenant') await this.auth.loadTenants().catch(() => []);
  }

  protected signOut() {
    void this.auth.signOut();
  }
}
