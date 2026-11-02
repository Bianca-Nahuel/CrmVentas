import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CircleDot, Hand, Pause, type IconNode } from 'lucide';
import type { LeadState } from '../../api/generated';
import { Icon } from '../../ui/icon';
import { STATE_LABELS } from './format';

const ICONS: Record<LeadState, IconNode> = { open: CircleDot, handed_off: Hand, ai_paused: Pause };
const TONES: Record<LeadState, string> = {
  open: 'text-muted',
  handed_off: 'text-warning',
  ai_paused: 'text-primary-strong',
};

/** Estado de la conversación con ícono y texto; "sin atender" si está derivada y nadie respondió. */
@Component({
  selector: 'app-lead-state-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'inline-flex flex-wrap items-center gap-1.5 text-sm' },
  template: `
    <span class="inline-flex items-center gap-1 font-medium" [class]="tone()">
      <app-icon [icon]="icon()" [size]="14" />{{ label() }}
    </span>
    @if (pending() && state() === 'handed_off') {
      <span class="rounded-sm bg-warning-soft px-1.5 text-xs font-semibold text-warning">Sin atender</span>
    }
  `,
})
export class LeadStateBadge {
  readonly state = input.required<LeadState>();
  readonly pending = input(false);
  protected readonly label = computed(() => STATE_LABELS[this.state()]);
  protected readonly icon = computed(() => ICONS[this.state()]);
  protected readonly tone = computed(() => TONES[this.state()]);
}
