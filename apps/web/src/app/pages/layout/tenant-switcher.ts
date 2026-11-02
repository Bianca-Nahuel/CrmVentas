import { CdkMenu, CdkMenuItemRadio, CdkMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core';
import type { MeTenantOption } from '@ventas/shared/auth';
import { Check, ChevronsUpDown } from 'lucide';
import { AuthService } from '../../core/auth/auth.service';
import { ROLE_LABELS } from '../../core/roles';
import { Icon } from '../../ui/icon';
import { NotifyService } from '../../ui/toast';

/** Nombre de la empresa activa; si el usuario tiene más de una, es un selector. */
@Component({
  selector: 'app-tenant-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkMenuTrigger, CdkMenu, CdkMenuItemRadio, Icon],
  host: { class: 'min-w-0' },
  template: `
    @if (canSwitch()) {
      <button
        type="button"
        class="flex max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2"
        [cdkMenuTriggerFor]="menu"
        [attr.aria-label]="'Empresa: ' + name() + '. Cambiar de empresa'"
        data-testid="tenant-switcher"
      >
        <span class="truncate text-[15px] font-bold text-text" data-testid="tenant-name">{{ name() }}</span>
        <app-icon [icon]="switchIcon" [size]="16" class="text-muted" />
      </button>
    } @else {
      <span class="block truncate px-2 text-[15px] font-bold text-text" data-testid="tenant-name">{{
        name()
      }}</span>
    }

    <ng-template #menu>
      <div class="menu w-72" cdkMenu aria-label="Cambiar de empresa">
        <p class="px-3 pt-1.5 pb-1 text-xs font-semibold tracking-wide text-subtle uppercase">
          Cambiar de empresa
        </p>
        @for (tenant of tenants(); track tenant.id) {
          <button
            type="button"
            class="menu-item"
            cdkMenuItemRadio
            [cdkMenuItemChecked]="tenant.id === currentId()"
            [cdkMenuItemDisabled]="switching()"
            (cdkMenuItemTriggered)="switchTo(tenant)"
          >
            <span class="flex min-w-0 flex-1 flex-col py-1">
              <span class="truncate font-semibold">{{ tenant.name }}</span>
              <span class="text-xs text-muted">{{ roleLabels[tenant.role] }}</span>
            </span>
            @if (tenant.id === currentId()) {
              <app-icon [icon]="checkIcon" [size]="16" class="text-primary" />
            }
          </button>
        }
      </div>
    </ng-template>
  `,
})
export class TenantSwitcher implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotifyService);

  protected readonly tenants = this.auth.tenants;
  protected readonly name = computed(() => this.auth.tenant()?.name ?? '');
  protected readonly currentId = computed(() => this.auth.tenant()?.id ?? null);
  protected readonly canSwitch = computed(() => this.tenants().length > 1);
  protected readonly switching = signal(false);
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly switchIcon = ChevronsUpDown;
  protected readonly checkIcon = Check;

  ngOnInit() {
    // Si falla, se muestra el nombre sin selector.
    this.auth.loadTenants().catch(() => undefined);
  }

  protected async switchTo(tenant: MeTenantOption) {
    if (tenant.id === this.currentId()) return;
    this.switching.set(true);
    const ok = await this.auth.switchTenant(tenant.id).catch(() => false);
    if (!ok) {
      this.switching.set(false);
      this.notify.show('No pudimos cambiar de empresa. Probá de nuevo.');
    }
  }
}
