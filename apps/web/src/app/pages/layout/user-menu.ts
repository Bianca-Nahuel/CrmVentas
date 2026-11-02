import { CdkMenu, CdkMenuItem, CdkMenuItemRadio, CdkMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Check, LogOut, Monitor, Moon, Sun, type IconNode } from 'lucide';
import { AuthService } from '../../core/auth/auth.service';
import { ROLE_LABELS } from '../../core/roles';
import { Icon } from '../../ui/icon';
import { ThemeService, type ThemePreference } from '../../ui/theme.service';

/** Menú del usuario: quién es, tema y cerrar sesión. */
@Component({
  selector: 'app-user-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkMenuTrigger, CdkMenu, CdkMenuItem, CdkMenuItemRadio, Icon],
  template: `
    <button
      type="button"
      class="flex size-10 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary-strong hover:ring-2 hover:ring-border-strong"
      [cdkMenuTriggerFor]="menu"
      aria-label="Menú de usuario"
      data-testid="user-menu"
    >
      <span aria-hidden="true">{{ initials() }}</span>
    </button>

    <ng-template #menu>
      <div class="menu w-64" cdkMenu>
        <div class="px-3 py-2">
          <p class="truncate text-sm font-semibold text-text">{{ auth.user()?.name }}</p>
          <p class="truncate text-sm text-muted">{{ auth.user()?.email }}</p>
          @if (auth.role(); as role) {
            <p class="mt-1 text-xs font-medium text-subtle">{{ roleLabels[role] }}</p>
          }
        </div>
        <div class="menu-separator" role="separator"></div>
        <p class="px-3 pt-1 pb-1 text-xs font-semibold tracking-wide text-subtle uppercase" id="theme-label">
          Tema
        </p>
        <div role="group" aria-labelledby="theme-label">
          @for (option of themeOptions; track option.value) {
            <button
              type="button"
              class="menu-item"
              cdkMenuItemRadio
              [cdkMenuItemChecked]="theme.preference() === option.value"
              (cdkMenuItemTriggered)="theme.set(option.value)"
            >
              <app-icon [icon]="option.icon" [size]="16" />
              <span class="flex-1">{{ option.label }}</span>
              @if (theme.preference() === option.value) {
                <app-icon [icon]="checkIcon" [size]="16" class="text-primary" />
              }
            </button>
          }
        </div>
        <div class="menu-separator" role="separator"></div>
        <button type="button" class="menu-item" cdkMenuItem (cdkMenuItemTriggered)="signOut()">
          <app-icon [icon]="logoutIcon" [size]="16" />
          Cerrar sesión
        </button>
      </div>
    </ng-template>
  `,
})
export class UserMenu {
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly checkIcon = Check;
  protected readonly logoutIcon = LogOut;
  protected readonly themeOptions: { value: ThemePreference; label: string; icon: IconNode }[] = [
    { value: 'system', label: 'Como el sistema', icon: Monitor },
    { value: 'light', label: 'Claro', icon: Sun },
    { value: 'dark', label: 'Oscuro', icon: Moon },
  ];

  protected readonly initials = computed(() => {
    const name = this.auth.user()?.name?.trim() ?? '';
    const parts = name.split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : name.slice(0, 2);
    return letters.toLocaleUpperCase('es-AR') || '?';
  });

  protected signOut() {
    void this.auth.signOut();
  }
}
