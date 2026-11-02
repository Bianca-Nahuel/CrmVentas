import { Directive, computed, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** <button appButton variant="secondary" size="sm">…</button>. Los estilos están en styles.css (.btn). */
@Directive({
  selector: 'button[appButton], a[appButton]',
  host: { '[class]': 'classes()' },
})
export class Button {
  readonly variant = input<ButtonVariant>('primary');
  readonly size = input<'md' | 'sm'>('md');
  protected readonly classes = computed(
    () => `btn btn-${this.variant()}${this.size() === 'sm' ? ' btn-sm' : ''}`,
  );
}
