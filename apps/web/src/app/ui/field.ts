import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CircleAlert } from 'lucide';
import { Icon } from './icon';

let nextId = 0;

/**
 * Etiqueta + control + ayuda + error, con los ids para aria-describedby. El control va proyectado y usa
 * los ids que expone el campo:
 *   <app-field label="Email" #f="appField" [error]="…">
 *     <input class="input" [id]="f.controlId" [attr.aria-describedby]="f.describedBy()" />
 *   </app-field>
 */
@Component({
  selector: 'app-field',
  exportAs: 'appField',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'flex flex-col gap-1.5' },
  template: `
    <label class="text-sm font-semibold text-text" [attr.for]="controlId">{{ label() }}</label>
    <ng-content />
    @if (hint()) {
      <p class="text-sm text-subtle" [id]="hintId">{{ hint() }}</p>
    }
    @if (error()) {
      <p class="flex items-center gap-1.5 text-sm font-medium text-error" [id]="errorId">
        <app-icon [icon]="alertIcon" [size]="16" />
        {{ error() }}
      </p>
    }
  `,
})
export class Field {
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly error = input<string | null>();

  readonly controlId = `field-${++nextId}`;
  protected readonly hintId = `${this.controlId}-hint`;
  protected readonly errorId = `${this.controlId}-error`;
  protected readonly alertIcon = CircleAlert;

  describedBy(): string | null {
    const ids = [this.hint() ? this.hintId : null, this.error() ? this.errorId : null].filter(Boolean);
    return ids.length ? ids.join(' ') : null;
  }
}
