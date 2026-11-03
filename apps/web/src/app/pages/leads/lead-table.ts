import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { LeadRow } from '../../api/generated';
import { Score } from '../../ui/score';
import { SortHeader, ariaSort, type SortState } from '../../ui/table';
import { CLOSE_OUTCOME_LABELS, contactName, fullWhen, previewText, shortWhen } from '../inbox/format';
import { LeadStateBadge } from '../inbox/lead-state-badge';

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Filas de leads: tabla nativa en el escritorio (decisión #81) y tarjetas en el celular. La comparten la grilla
 * de leads (con orden, cierre y tiempo real) y las listas del embudo (tarea 028), que solo muestran las filas.
 * Cada fila lleva a la conversación. Todo lo que viene del servidor se muestra como texto.
 */
@Component({
  selector: 'app-lead-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Score, SortHeader, LeadStateBadge],
  template: `
    <div class="card hidden overflow-x-auto md:block">
      <table class="w-full text-left text-sm" [attr.aria-label]="label()">
        <thead>
          <tr class="border-b border-border bg-surface-2">
            <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Contacto</th>
            <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Número</th>
            @if (sortable()) {
              <th scope="col" class="px-4 py-2.5" [attr.aria-sort]="ariaSort(sort(), 'score')">
                <app-sort-header
                  column="score"
                  label="Puntaje"
                  [sort]="sort()"
                  (sortChange)="sortChange.emit($event)"
                />
              </th>
            } @else {
              <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Puntaje</th>
            }
            <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Estado</th>
            @if (sortable()) {
              <th scope="col" class="px-4 py-2.5" [attr.aria-sort]="ariaSort(sort(), 'last_message')">
                <app-sort-header
                  column="last_message"
                  label="Último mensaje"
                  [sort]="sort()"
                  (sortChange)="sortChange.emit($event)"
                />
              </th>
            } @else {
              <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Último mensaje</th>
            }
            @if (canClose()) {
              <th scope="col" class="px-4 py-2.5"><span class="sr-only">Acciones</span></th>
            }
          </tr>
        </thead>
        <tbody>
          @for (lead of rows(); track lead.id) {
            <!-- Toda la fila abre la conversación con el mouse; con teclado, el link del nombre. -->
            <tr
              class="h-[var(--row-height)] cursor-pointer border-b border-border last:border-0 hover:bg-surface-2"
              [class.live-new]="newIds().has(lead.id)"
              [class.live-flash]="flashIds().has(lead.id)"
              data-testid="lead-row"
              (click)="openRow($event, lead.id)"
            >
              <td class="px-4 py-2.5">
                <span class="flex items-center gap-2">
                  @if (newIds().has(lead.id)) {
                    <span class="live-chip" data-testid="new-chip">Nueva</span>
                  }
                  <a
                    class="block max-w-48 truncate font-semibold text-text hover:text-primary hover:underline"
                    [routerLink]="['/conversaciones', lead.id]"
                    >{{ name(lead) }}</a
                  >
                </span>
                <span class="tabular block max-w-48 truncate text-subtle">{{ lead.contact.waId }}</span>
              </td>
              <td class="px-4">
                <span class="block max-w-40 truncate text-text">{{ lead.channel.name }}</span>
                <span class="tabular block max-w-40 truncate text-subtle">{{
                  lead.channel.phoneNumber
                }}</span>
              </td>
              <td class="px-4"><app-score [score]="lead.score" [level]="lead.tier" /></td>
              <td class="px-4">
                @if (lead.closed; as closed) {
                  <span class="text-muted">Cerrada · {{ outcomeLabel(closed.outcome) }}</span>
                } @else {
                  <app-lead-state-badge [state]="lead.state" [pending]="lead.pendingHandoff" />
                }
              </td>
              <td class="px-4">
                <span class="block max-w-60 truncate text-text" [attr.title]="preview(lead)">{{
                  preview(lead)
                }}</span>
                <time
                  class="tabular block text-subtle"
                  [attr.datetime]="lead.lastMessageAt"
                  [attr.title]="fullWhen(lead.lastMessageAt)"
                  >{{ when(lead.lastMessageAt) }}</time
                >
              </td>
              @if (canClose()) {
                <td class="px-4 text-right">
                  @if (!lead.closed) {
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      data-testid="row-close"
                      [attr.aria-label]="'Cerrar la conversación con ' + name(lead)"
                      (click)="closeRow.emit(lead)"
                    >
                      Cerrar
                    </button>
                  }
                </td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>

    <ul class="flex flex-col gap-2 md:hidden" [attr.aria-label]="label()">
      @for (lead of rows(); track lead.id) {
        <li>
          <a
            class="card flex flex-col gap-1.5 p-3.5 hover:border-border-strong"
            [class.live-new]="newIds().has(lead.id)"
            [class.live-flash]="flashIds().has(lead.id)"
            [routerLink]="['/conversaciones', lead.id]"
            data-testid="lead-card"
          >
            <span class="flex items-center justify-between gap-3">
              <span class="flex min-w-0 items-center gap-2">
                @if (newIds().has(lead.id)) {
                  <span class="live-chip" data-testid="new-chip">Nueva</span>
                }
                <span class="truncate font-semibold text-text">{{ name(lead) }}</span>
              </span>
              <app-score [score]="lead.score" [level]="lead.tier" variant="compact" />
            </span>
            <span class="flex flex-wrap items-center gap-2 text-sm text-muted">
              <span class="truncate">{{ lead.channel.name }}</span>
              @if (lead.closed; as closed) {
                <span>Cerrada · {{ outcomeLabel(closed.outcome) }}</span>
              } @else {
                <app-lead-state-badge [state]="lead.state" [pending]="lead.pendingHandoff" />
              }
            </span>
            <span class="flex items-baseline justify-between gap-3 text-sm">
              <span class="truncate text-text">{{ preview(lead) }}</span>
              <time class="tabular shrink-0 text-subtle" [attr.datetime]="lead.lastMessageAt">{{
                when(lead.lastMessageAt)
              }}</time>
            </span>
          </a>
        </li>
      }
    </ul>
  `,
})
export class LeadTable {
  private readonly router = inject(Router);

  readonly rows = input.required<LeadRow[]>();
  /** Nombre accesible de la tabla y de la lista. */
  readonly label = input('Leads');
  /** Con orden por columnas (la grilla). Sin él, encabezados fijos. */
  readonly sortable = input(false);
  readonly sort = input<SortState | null>(null);
  readonly canClose = input(false);
  /** Tiempo real (solo la grilla): filas nuevas y actualizadas. */
  readonly newIds = input<ReadonlySet<string>>(NO_IDS);
  readonly flashIds = input<ReadonlySet<string>>(NO_IDS);

  readonly sortChange = output<SortState>();
  readonly closeRow = output<LeadRow>();

  protected readonly ariaSort = ariaSort;
  protected readonly outcomeLabel = (outcome: keyof typeof CLOSE_OUTCOME_LABELS) =>
    CLOSE_OUTCOME_LABELS[outcome];
  protected readonly name = (lead: LeadRow) => contactName(lead.contact);
  protected readonly preview = (lead: LeadRow) => previewText(lead.lastMessage);
  protected readonly when = (iso: string) => shortWhen(iso);
  protected readonly fullWhen = fullWhen;

  /** Clic en cualquier parte de la fila. Si fue en el link del nombre o en un botón, ya hace lo suyo. */
  protected openRow(event: MouseEvent, id: string) {
    if ((event.target as HTMLElement).closest('a, button')) return;
    void this.router.navigate(['/conversaciones', id]);
  }
}
