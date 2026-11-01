import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Ban, Check, CheckCheck, CircleAlert, Clock, type IconNode } from 'lucide';
import type { Delivery } from '../../api/generated';
import { Icon } from '../../ui/icon';
import { deliveryLabel } from './format';

const ICONS: Record<NonNullable<Delivery>['state'], IconNode> = {
  queued: Clock,
  sending: Clock,
  sent: Check,
  delivered: CheckCheck,
  read: CheckCheck,
  failed: CircleAlert,
  rejected: Ban,
};

/** Estado de un mensaje saliente: ícono + texto (nunca solo color). */
@Component({
  selector: 'app-delivery-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    class: 'inline-flex items-center gap-1 text-[11px] font-semibold',
    '[class]': 'tone()',
    '[attr.data-state]': 'delivery().state',
    'data-testid': 'delivery',
  },
  template: `<app-icon [icon]="icon()" [size]="13" [strokeWidth]="2.25" />{{ label() }}`,
})
export class DeliveryStatus {
  readonly delivery = input.required<NonNullable<Delivery>>();

  protected readonly icon = computed(() => ICONS[this.delivery().state]);
  protected readonly label = computed(() => deliveryLabel(this.delivery()));
  protected readonly tone = computed(() => {
    switch (this.delivery().state) {
      case 'read':
        return 'text-primary-strong';
      case 'failed':
        return this.delivery().reason === 'maybe_sent' ? 'text-warning' : 'text-error';
      case 'rejected':
        return 'text-error';
      default:
        return 'text-subtle';
    }
  });
}
