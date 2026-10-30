import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Tonos del punto de una etiqueta. Neutros por diseño: el color es un detalle, el texto manda. */
export type TagTone = 'neutral' | 'primary' | 'hot' | 'warm' | 'cold' | 'success';

const DOT: Record<TagTone, string> = {
  neutral: 'bg-border-strong',
  primary: 'bg-primary',
  hot: 'bg-hot',
  warm: 'bg-warm',
  cold: 'bg-cold',
  success: 'bg-success',
};

/** Píldora de etiqueta: fondo neutro, texto en minúsculas y un punto de color opcional. */
@Component({
  selector: 'app-tag',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'inline-flex h-6 max-w-40 items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2 text-xs font-medium text-muted',
  },
  template: `
    @if (tone() !== 'neutral') {
      <span class="size-1.5 shrink-0 rounded-full" [class]="dotClass()" aria-hidden="true"></span>
    }
    <span class="truncate">{{ label().toLocaleLowerCase('es-AR') }}</span>
  `,
})
export class Tag {
  readonly label = input.required<string>();
  readonly tone = input<TagTone>('neutral');
  protected readonly dotClass = computed(() => DOT[this.tone()]);
}

/** Lista de etiquetas que muestra hasta `max` y resume el resto en "+N". */
@Component({
  selector: 'app-tag-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Tag],
  host: { class: 'flex flex-wrap items-center gap-1' },
  template: `
    @for (tag of visible(); track tag.label) {
      <app-tag [label]="tag.label" [tone]="tag.tone ?? 'neutral'" />
    }
    @if (hidden().length) {
      <span
        class="inline-flex h-6 items-center rounded-sm px-1.5 text-xs font-semibold text-muted"
        [attr.title]="hiddenTitle()"
        [attr.aria-label]="'y ' + hidden().length + ' más: ' + hiddenTitle()"
        >+{{ hidden().length }}</span
      >
    }
  `,
})
export class TagList {
  readonly tags = input.required<readonly { label: string; tone?: TagTone }[]>();
  readonly max = input(3);
  protected readonly visible = computed(() => this.tags().slice(0, this.max()));
  protected readonly hidden = computed(() => this.tags().slice(this.max()));
  protected readonly hiddenTitle = computed(() =>
    this.hidden()
      .map((t) => t.label)
      .join(', '),
  );
}
