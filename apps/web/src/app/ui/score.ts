import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CircleDashed, Flame, Snowflake, ThermometerSun, type IconNode } from 'lucide';
import { Icon } from './icon';

/** Nivel del lead tal como lo guarda el backend (conversations.lead_tier). */
export type LeadLevel = 'hot' | 'warm' | 'cold';

interface LevelInfo {
  label: string;
  icon: IconNode;
  text: string;
  soft: string;
  bar: string;
}

export const LEAD_LEVELS: Record<LeadLevel, LevelInfo> = {
  hot: { label: 'Caliente', icon: Flame, text: 'text-hot', soft: 'bg-hot-soft', bar: 'bg-hot' },
  warm: { label: 'Tibio', icon: ThermometerSun, text: 'text-warm', soft: 'bg-warm-soft', bar: 'bg-warm' },
  cold: { label: 'Frío', icon: Snowflake, text: 'text-cold', soft: 'bg-cold-soft', bar: 'bg-cold' },
};

const UNRATED: LevelInfo = {
  label: 'Sin calificar',
  icon: CircleDashed,
  text: 'text-muted',
  soft: 'bg-surface-2',
  bar: 'bg-border-strong',
};

/**
 * Indicador de puntaje (0 a 100) con el nivel del lead. NO calcula el nivel: lo decide el backend con los
 * umbrales de la configuración de cada empresa. Número, ícono, texto y color siempre dicen lo mismo, así
 * que se entiende sin color.
 *   row     → celda de tabla en escritorio: número + ícono + texto + barra fina.
 *   compact → tarjeta en el celular: píldora con ícono + número (el texto va en aria-label y title).
 *   full    → detalle del lead: "78 / 100", barra más alta y el nivel.
 */
@Component({
  selector: 'app-score',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    // Sin puntaje no hay valor que medir: se anuncia como imagen con su texto.
    '[attr.role]': "value() === null ? 'img' : 'meter'",
    '[attr.aria-valuemin]': 'value() === null ? null : 0',
    '[attr.aria-valuemax]': 'value() === null ? null : 100',
    '[attr.aria-valuenow]': 'value()',
    '[attr.aria-valuetext]': 'valueText()',
    '[attr.aria-label]': 'ariaLabel()',
    '[attr.title]': "variant() === 'compact' ? valueText() : null",
    '[class]': 'hostClass()',
  },
  template: `
    @switch (variant()) {
      @case ('compact') {
        <span
          class="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-sm font-bold"
          [class]="info().soft + ' ' + info().text"
          aria-hidden="true"
        >
          <app-icon [icon]="info().icon" [size]="15" [strokeWidth]="2.25" />
          <span class="tabular">{{ display() }}</span>
        </span>
      }
      @case ('full') {
        <div class="flex items-baseline justify-between gap-3" aria-hidden="true">
          <span class="text-sm font-semibold text-muted">Puntaje</span>
          <span class="tabular text-2xl font-bold text-text"
            >{{ display() }}<span class="text-base font-semibold text-subtle"> / 100</span></span
          >
        </div>
        <div class="mt-2 flex items-center gap-3" aria-hidden="true">
          <span class="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
            <span
              class="absolute inset-y-0 left-0 rounded-full"
              [class]="info().bar"
              [style.width.%]="width()"
            ></span>
          </span>
          <span class="inline-flex items-center gap-1 text-sm font-semibold" [class]="info().text">
            <app-icon [icon]="info().icon" [size]="16" />
            {{ info().label }}
          </span>
        </div>
      }
      @default {
        <span class="tabular w-7 text-right text-base font-semibold text-text" aria-hidden="true">{{
          display()
        }}</span>
        <span
          class="inline-flex w-28 items-center gap-1 text-sm font-semibold whitespace-nowrap"
          [class]="info().text"
          aria-hidden="true"
        >
          <app-icon [icon]="info().icon" [size]="16" />
          {{ info().label }}
        </span>
        <span
          class="relative hidden h-1 w-20 overflow-hidden rounded-full bg-surface-2 lg:block"
          aria-hidden="true"
        >
          <span
            class="absolute inset-y-0 left-0 rounded-full"
            [class]="info().bar"
            [style.width.%]="width()"
          ></span>
        </span>
      }
    }
  `,
})
export class Score {
  readonly score = input<number | null>(null);
  readonly level = input<LeadLevel | null>(null);
  readonly variant = input<'row' | 'compact' | 'full'>('row');

  /** Puntaje entero entre 0 y 100, o null si todavía no hay. */
  protected readonly value = computed(() => {
    const score = this.score();
    if (score === null || !Number.isFinite(score)) return null;
    return Math.round(Math.min(100, Math.max(0, score)));
  });

  protected readonly info = computed(() => {
    const level = this.level();
    return this.value() === null || !level ? UNRATED : LEAD_LEVELS[level];
  });

  protected readonly display = computed(() => this.value() ?? '—');
  protected readonly width = computed(() => this.value() ?? 0);

  protected readonly valueText = computed(() => {
    const value = this.value();
    if (value === null) return 'Sin calificar';
    return `${value} de 100, ${this.info().label.toLocaleLowerCase('es-AR')}`;
  });

  protected readonly ariaLabel = computed(() =>
    this.value() === null ? 'Puntaje del lead: sin calificar' : 'Puntaje del lead',
  );

  protected readonly hostClass = computed(() => {
    switch (this.variant()) {
      case 'compact':
        return 'inline-flex';
      case 'full':
        return 'block';
      default:
        return 'inline-flex items-center gap-2';
    }
  });
}
