import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { CdkListbox, CdkOption } from '@angular/cdk/listbox';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Check } from 'lucide';
import type { ChannelWithMembers, MemberRef } from '../../api/generated';
import { Icon } from '../../ui/icon';

export interface AssignSellersData {
  channel: ChannelWithMembers;
  sellers: MemberRef[];
}

/**
 * Elegir los vendedores de un número: lista de selección múltiple de la CDK (flechas para moverse,
 * espacio para marcar). Devuelve los userIds elegidos, o undefined si se canceló.
 */
@Component({
  selector: 'app-assign-sellers-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkListbox, CdkOption, Icon],
  host: { class: 'card flex max-h-[85dvh] w-[min(92vw,440px)] flex-col p-5 shadow-3' },
  template: `
    <h2 class="text-lg font-semibold text-text" id="assign-title">Vendedores de {{ data.channel.name }}</h2>
    <p class="mt-1 text-sm text-muted" id="assign-hint">
      Van a ver las conversaciones de {{ data.channel.phoneNumber ?? data.channel.name }}. Usá las flechas y
      la barra espaciadora.
    </p>
    @if (data.sellers.length === 0) {
      <p class="mt-4 text-muted">Todavía no hay vendedores en la empresa.</p>
    } @else {
      <ul
        cdkListbox
        cdkListboxMultiple
        [cdkListboxValue]="selected()"
        (cdkListboxValueChange)="selected.set($any($event.value))"
        aria-labelledby="assign-title"
        aria-describedby="assign-hint"
        class="mt-4 flex min-h-0 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        data-testid="sellers-listbox"
      >
        @for (seller of data.sellers; track seller.userId) {
          <li
            [cdkOption]="seller.userId"
            class="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-2.5 py-1.5 hover:bg-surface-2 aria-selected:bg-primary-soft data-[cdk-option-active]:outline-2 data-[cdk-option-active]:outline-primary [&.cdk-option-active]:outline-2 [&.cdk-option-active]:outline-primary"
          >
            <span
              class="flex size-5 shrink-0 items-center justify-center rounded-sm border border-border-strong"
              [class.bg-primary]="isSelected(seller.userId)"
              [class.border-primary]="isSelected(seller.userId)"
              aria-hidden="true"
            >
              @if (isSelected(seller.userId)) {
                <app-icon [icon]="checkIcon" [size]="14" class="text-on-primary" />
              }
            </span>
            <span class="min-w-0">
              <span class="block truncate font-medium text-text">{{ seller.name }}</span>
              <span class="block truncate text-sm text-subtle">{{ seller.email }}</span>
            </span>
          </li>
        }
      </ul>
    }
    <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <button type="button" class="btn btn-secondary" (click)="ref.close()">Cancelar</button>
      <button
        type="button"
        class="btn btn-primary"
        (click)="ref.close(selected())"
        data-testid="save-sellers"
      >
        Guardar
      </button>
    </div>
  `,
})
export class AssignSellersDialog {
  protected readonly data = inject<AssignSellersData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<string[]>>(DialogRef);
  protected readonly selected = signal<string[]>(this.data.channel.sellers.map((seller) => seller.userId));
  protected readonly checkIcon = Check;

  protected isSelected(userId: string) {
    return this.selected().includes(userId);
  }
}
