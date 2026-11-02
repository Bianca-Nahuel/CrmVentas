import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { weekLabel } from './performance-format';

export interface ChartSeries {
  label: string;
  values: (number | null)[];
  /** Línea y marcador distintos por serie: se distinguen sin depender del color. */
  line: 'solid' | 'dashed' | 'dotted';
  marker: 'circle' | 'square' | 'triangle';
  tone: 'primary' | 'warning' | 'muted';
}

/** Más angosto en el celular: el SVG escala y así los textos no quedan diminutos. */
const WIDTH = { wide: 640, narrow: 360 };
const HEIGHT = 220;
/** Separación mínima entre las etiquetas de las semanas (unidades del viewBox). */
const LABEL_GAP = 44;
const PAD = { top: 16, right: 16, bottom: 28, left: 40 };
const DASH = { solid: '', dashed: '6 4', dotted: '2 4' } as const;
const LINE = { primary: 'stroke-primary', warning: 'stroke-warning', muted: 'stroke-muted' };
const MARK = { primary: 'fill-primary', warning: 'fill-warning', muted: 'fill-muted' };

let nextId = 0;

/**
 * Gráfico semanal en SVG propio (tarea 026, sin librerías). Accesible: figura con un resumen para lectores
 * de pantalla, la tabla equivalente siempre en el DOM (visible con "Ver como tabla") y cada serie con su
 * línea, marcador y etiqueta; el color es un refuerzo. Los colores salen de los tokens.
 */
@Component({
  selector: 'app-weekly-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="m-0" [attr.aria-labelledby]="captionId">
      <figcaption [id]="captionId" class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-semibold text-text">{{ title() }}</span>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          [attr.aria-expanded]="showTable()"
          [attr.aria-controls]="tableId"
          (click)="showTable.set(!showTable())"
        >
          {{ showTable() ? 'Ver gráfico' : 'Ver como tabla' }}
        </button>
      </figcaption>

      <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted" aria-hidden="true">
        @for (s of series(); track s.label) {
          <li class="flex items-center gap-1.5">
            <svg width="28" height="10" viewBox="0 0 28 10">
              <line
                x1="0"
                y1="5"
                x2="28"
                y2="5"
                stroke-width="2"
                [class]="line(s)"
                [attr.stroke-dasharray]="dash(s)"
              />
              <path [attr.d]="markerPath(s, 14, 5)" [class]="mark(s)" />
            </svg>
            {{ s.label }}
          </li>
        }
      </ul>

      @if (!showTable()) {
        <svg
          class="mt-2 h-auto w-full"
          [attr.viewBox]="'0 0 ' + width + ' ' + height"
          role="img"
          [attr.aria-label]="summary()"
        >
          @for (tick of ticks(); track tick.value) {
            <line
              [attr.x1]="pad.left"
              [attr.x2]="width - pad.right"
              [attr.y1]="tick.y"
              [attr.y2]="tick.y"
              class="stroke-border"
              stroke-width="1"
            />
            <text
              [attr.x]="pad.left - 6"
              [attr.y]="tick.y + 4"
              text-anchor="end"
              class="fill-subtle text-[11px]"
            >
              {{ tick.label }}
            </text>
          }
          @for (week of weeks(); track week; let i = $index) {
            @if ((weeks().length - 1 - i) % labelStep() === 0) {
              <text
                [attr.x]="x(i)"
                [attr.y]="height - 8"
                text-anchor="middle"
                class="fill-subtle text-[11px]"
              >
                {{ short(week) }}
              </text>
            }
          }
          @for (s of series(); track s.label) {
            <path
              [attr.d]="linePath(s)"
              fill="none"
              stroke-width="2"
              [class]="line(s)"
              [attr.stroke-dasharray]="dash(s)"
            />
            @for (value of s.values; track $index; let i = $index) {
              @if (value !== null) {
                <path [attr.d]="markerPath(s, x(i), y(value))" [class]="mark(s)">
                  <title>{{ s.label }}, {{ long(weeks()[i]!) }}: {{ format()(value) }}</title>
                </path>
              }
            }
          }
        </svg>
      }

      <div [id]="tableId" [class]="showTable() ? 'mt-2 overflow-x-auto' : 'sr-only'">
        <table class="w-full text-left text-sm">
          <caption class="sr-only">
            {{
              title()
            }}, por semana
          </caption>
          <thead>
            <tr class="border-b border-border">
              <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Semana</th>
              @for (s of series(); track s.label) {
                <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">{{ s.label }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (week of weeks(); track week; let i = $index) {
              <tr class="border-b border-border last:border-0">
                <th scope="row" class="py-1.5 pr-3 font-normal text-text">{{ long(week) }}</th>
                @for (s of series(); track s.label) {
                  <td class="tabular py-1.5 pr-3 text-text">
                    {{ s.values[i] === null || s.values[i] === undefined ? '—' : format()(s.values[i]!) }}
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    </figure>
  `,
})
export class WeeklyChart {
  readonly title = input.required<string>();
  readonly weeks = input.required<string[]>();
  readonly series = input.required<ChartSeries[]>();
  readonly format = input<(value: number) => string>((value) => String(value));

  protected readonly showTable = signal(false);
  protected readonly captionId = `chart-caption-${++nextId}`;
  protected readonly tableId = `chart-table-${nextId}`;
  protected readonly width = globalThis.matchMedia?.('(max-width: 639px)').matches
    ? WIDTH.narrow
    : WIDTH.wide;
  protected readonly height = HEIGHT;
  protected readonly pad = PAD;
  protected readonly short = (week: string) => weekLabel(week);
  protected readonly long = (week: string) => weekLabel(week, true);

  private readonly max = computed(() => {
    const values = this.series().flatMap((s) => s.values.filter((v): v is number => v !== null));
    const top = Math.max(1, ...values);
    // Un tope "redondo" y par: las líneas de referencia (0, mitad y tope) quedan en números enteros.
    const step = 10 ** Math.floor(Math.log10(top));
    const rounded = Math.ceil(top / step) * step;
    return rounded % 2 === 0 ? rounded : rounded + step;
  });

  /** Cada cuántas semanas se escribe la fecha, contando desde la última (con 26 no entran todas). */
  protected readonly labelStep = computed(() => {
    const slot = (this.width - PAD.left - PAD.right) / Math.max(1, this.weeks().length - 1);
    return Math.max(1, Math.ceil(LABEL_GAP / slot));
  });

  protected readonly ticks = computed(() =>
    [0, 0.5, 1].map((fraction) => {
      const value = this.max() * fraction;
      return { value, y: this.y(value), label: this.format()(value) };
    }),
  );

  /** Lo que lee un lector de pantalla en lugar del dibujo. */
  protected readonly summary = computed(() => {
    const weeks = this.weeks();
    if (weeks.length === 0) return this.title();
    const last = weeks.length - 1;
    const parts = this.series().map((s) => {
      const value = s.values[last];
      return `${s.label}: ${value === null || value === undefined ? 'sin datos' : this.format()(value)}`;
    });
    return `${this.title()}. ${weeks.length} semanas. Última semana (${this.long(weeks[last]!)}): ${parts.join('; ')}. La tabla con todos los valores está a continuación.`;
  });

  protected x(index: number): number {
    const count = Math.max(1, this.weeks().length - 1);
    return PAD.left + ((this.width - PAD.left - PAD.right) * index) / count;
  }

  protected y(value: number): number {
    return HEIGHT - PAD.bottom - ((HEIGHT - PAD.top - PAD.bottom) * value) / this.max();
  }

  /** Tramos de línea; un valor null corta la línea. */
  protected linePath(s: ChartSeries): string {
    let path = '';
    let pen = false;
    s.values.forEach((value, index) => {
      if (value === null) {
        pen = false;
        return;
      }
      path += `${pen ? 'L' : 'M'}${this.x(index).toFixed(1)} ${this.y(value).toFixed(1)} `;
      pen = true;
    });
    return path.trim();
  }

  protected markerPath(s: ChartSeries, cx: number, cy: number): string {
    const r = 4;
    switch (s.marker) {
      case 'square':
        return `M${cx - r} ${cy - r}h${2 * r}v${2 * r}h${-2 * r}Z`;
      case 'triangle':
        return `M${cx} ${cy - r - 1}L${cx + r + 1} ${cy + r}L${cx - r - 1} ${cy + r}Z`;
      default:
        return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
    }
  }

  protected line(s: ChartSeries): string {
    return LINE[s.tone];
  }

  protected mark(s: ChartSeries): string {
    return MARK[s.tone];
  }

  protected dash(s: ChartSeries): string | null {
    return DASH[s.line] || null;
  }
}
