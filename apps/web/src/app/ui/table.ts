import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide';
import { Icon } from './icon';

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  column: string;
  direction: SortDirection;
}

/**
 * Encabezado ordenable para una tabla (nativa en Leads, decisión #81; o cdk-table). El orden lo aplica quien
 * carga los datos (en la 014, el servidor): este componente solo muestra el estado y avisa el cambio.
 *   <th scope="col" [attr.aria-sort]="ariaSort(sort, 'score')">
 *     <app-sort-header column="score" label="Puntaje" [sort]="sort()" (sortChange)="…" />
 */
@Component({
  selector: 'app-sort-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <button
      type="button"
      class="-mx-2 inline-flex min-h-8 items-center gap-1 rounded-sm px-2 font-semibold text-muted hover:text-text"
      (click)="toggle()"
    >
      {{ label() }}
      <app-icon [icon]="icon()" [size]="14" [class.text-primary]="active()" />
      <span class="sr-only">{{ hint() }}</span>
    </button>
  `,
})
export class SortHeader {
  readonly column = input.required<string>();
  readonly label = input.required<string>();
  readonly sort = input<SortState | null>(null);
  readonly sortChange = output<SortState>();

  protected readonly active = computed(() => this.sort()?.column === this.column());
  protected readonly icon = computed(() => {
    if (!this.active()) return ArrowUpDown;
    return this.sort()?.direction === 'asc' ? ArrowUp : ArrowDown;
  });
  protected readonly hint = computed(() =>
    this.active() && this.sort()?.direction === 'desc'
      ? 'Ordenar de menor a mayor'
      : 'Ordenar de mayor a menor',
  );

  protected toggle() {
    const direction: SortDirection = this.active() && this.sort()?.direction === 'desc' ? 'asc' : 'desc';
    this.sortChange.emit({ column: this.column(), direction });
  }
}

/** Valor de aria-sort para el <th> de una columna. */
export function ariaSort(sort: SortState | null, column: string): 'ascending' | 'descending' | 'none' {
  if (sort?.column !== column) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

/** Paginador simple (página actual de un total), pensado para paginar en el servidor. */
@Component({
  selector: 'app-paginator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'flex items-center justify-between gap-3 text-sm text-muted' },
  template: `
    <p class="tabular" aria-live="polite">{{ from() }}–{{ to() }} de {{ total() }}</p>
    <nav class="flex items-center gap-1" aria-label="Paginación">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        [disabled]="page() === 0"
        (click)="pageChange.emit(page() - 1)"
        aria-label="Página anterior"
      >
        <app-icon [icon]="prevIcon" />
      </button>
      <span class="tabular px-1">Página {{ page() + 1 }} de {{ pages() }}</span>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        [disabled]="page() + 1 >= pages()"
        (click)="pageChange.emit(page() + 1)"
        aria-label="Página siguiente"
      >
        <app-icon [icon]="nextIcon" />
      </button>
    </nav>
  `,
})
export class Paginator {
  readonly page = input.required<number>();
  readonly pageSize = input.required<number>();
  readonly total = input.required<number>();
  readonly pageChange = output<number>();

  protected readonly prevIcon = ChevronLeft;
  protected readonly nextIcon = ChevronRight;
  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  protected readonly from = computed(() => (this.total() === 0 ? 0 : this.page() * this.pageSize() + 1));
  protected readonly to = computed(() => Math.min(this.total(), (this.page() + 1) * this.pageSize()));
}
