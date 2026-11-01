import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { RefreshCw, Search, Users } from 'lucide';
import { InboxApi } from '../../api/inbox-api';
import type { LeadRow } from '../../api/generated';
import { InboxSummary } from '../../core/inbox-summary';
import { pollWhileVisible } from '../../core/poll';
import { query } from '../../core/query';
import { Icon } from '../../ui/icon';
import { Score } from '../../ui/score';
import { Paginator, SortHeader, ariaSort, type SortState } from '../../ui/table';
import { contactName, previewText, shortWhen, STATE_LABELS, fullWhen } from '../inbox/format';
import { LeadStateBadge } from '../inbox/lead-state-badge';
import {
  DEFAULT_QUERY,
  LEADS_PAGE_SIZE,
  hasFilters,
  parseLeadQuery,
  toApiParams,
  toQueryParams,
  type LeadQuery,
  type LeadSort,
} from './lead-query';

const SEARCH_DELAY_MS = 300;

// Orden en el celular (sin encabezados de tabla): un solo selector.
const MOBILE_SORTS = [
  { value: 'default:desc', label: 'Prioridad' },
  { value: 'score:desc', label: 'Puntaje: mayor primero' },
  { value: 'score:asc', label: 'Puntaje: menor primero' },
  { value: 'last_message:desc', label: 'Más recientes' },
  { value: 'last_message:asc', label: 'Más antiguos' },
] as const;

/**
 * Grilla de leads (tarea 014). Ordena, filtra y pagina el servidor; el estado vive en la URL. En el
 * escritorio, tabla nativa (decisión #81); en el celular, tarjetas. Se refresca sola cada 30 s con la pestaña visible.
 */
@Component({
  selector: 'app-leads-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Score, SortHeader, Paginator, LeadStateBadge],
  template: `
    <div class="flex items-center justify-between gap-3">
      <h1 class="text-2xl sm:text-[28px] sm:leading-[34px]">Leads</h1>
      <button type="button" class="btn btn-ghost btn-sm" (click)="refresh()" [disabled]="leads.isLoading()">
        <app-icon [icon]="refreshIcon" [size]="16" />
        <span class="max-sm:sr-only">Actualizar</span>
      </button>
    </div>

    <form
      class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]"
      role="search"
      (submit)="$event.preventDefault()"
    >
      <div class="relative sm:col-span-2 lg:col-span-1">
        <label for="leads-q" class="sr-only">Buscar por nombre o número</label>
        <app-icon
          [icon]="searchIcon"
          [size]="17"
          class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle"
        />
        <input
          id="leads-q"
          class="input pl-9"
          type="search"
          autocomplete="off"
          maxlength="100"
          placeholder="Buscar por nombre o número"
          [value]="searchText()"
          (input)="onSearch($any($event.target).value)"
        />
      </div>
      <div>
        <label for="leads-tier" class="sr-only">Nivel</label>
        <select
          id="leads-tier"
          class="input"
          [value]="query().tier ?? ''"
          (change)="setFilter('tier', $any($event.target).value)"
        >
          <option value="">Todos los niveles</option>
          <option value="hot">Caliente</option>
          <option value="warm">Tibio</option>
          <option value="cold">Frío</option>
          <option value="none">Sin calificar</option>
        </select>
      </div>
      <div>
        <label for="leads-status" class="sr-only">Estado</label>
        <select
          id="leads-status"
          class="input"
          [value]="query().status ?? ''"
          (change)="setFilter('status', $any($event.target).value)"
        >
          <option value="">Todos los estados</option>
          <option value="handed_off">{{ stateLabels.handed_off }}</option>
          <option value="ai_paused">{{ stateLabels.ai_paused }}</option>
          <option value="open">{{ stateLabels.open }}</option>
        </select>
      </div>
      <div>
        <label for="leads-channel" class="sr-only">Número</label>
        <select
          id="leads-channel"
          class="input"
          [value]="query().channel ?? ''"
          (change)="setFilter('channel', $any($event.target).value)"
        >
          <option value="">Todos los números</option>
          @for (channel of summary.channels(); track channel.id) {
            <option [value]="channel.id">{{ channel.name }} · {{ channel.phoneNumber }}</option>
          }
        </select>
      </div>
      <div class="md:hidden sm:col-span-2">
        <label for="leads-sort" class="sr-only">Orden</label>
        <select
          id="leads-sort"
          class="input"
          [value]="query().sort + ':' + query().dir"
          (change)="setMobileSort($any($event.target).value)"
        >
          @for (option of mobileSorts; track option.value) {
            <option [value]="option.value">Orden: {{ option.label }}</option>
          }
        </select>
      </div>
    </form>

    <p class="sr-only" aria-live="polite">{{ statusText() }}</p>
    <section class="mt-5" [attr.aria-busy]="leads.isLoading()">
      @if (leads.loadFailed()) {
        <div class="card flex flex-col items-start gap-3 p-5" data-testid="leads-error">
          <p class="font-semibold text-text">No pudimos cargar los leads.</p>
          <button type="button" class="btn btn-secondary btn-sm" (click)="refresh()">Reintentar</button>
        </div>
      } @else if (!leads.hasValue()) {
        <div class="card divide-y divide-border" aria-label="Cargando leads">
          @for (row of skeleton; track row) {
            <div class="flex items-center gap-4 px-4 py-3">
              <span class="h-4 w-40 animate-pulse rounded-sm bg-surface-2"></span>
              <span class="h-4 flex-1 animate-pulse rounded-sm bg-surface-2"></span>
            </div>
          }
        </div>
      } @else if (rows().length === 0) {
        <div class="card flex flex-col items-start gap-2 p-5 sm:p-6" data-testid="leads-empty">
          <span
            class="flex size-11 items-center justify-center rounded-md bg-primary-soft text-primary-strong"
          >
            <app-icon [icon]="usersIcon" [size]="22" />
          </span>
          @if (noChannels()) {
            <p class="font-semibold text-text">Todavía no tenés números asignados.</p>
            <p class="text-muted">
              Vas a ver acá los leads de los números de WhatsApp que te asigne un administrador de la empresa.
            </p>
          } @else if (filtered()) {
            <p class="font-semibold text-text">No hay leads con estos filtros.</p>
            <button type="button" class="btn btn-secondary btn-sm" (click)="clearFilters()">
              Limpiar filtros
            </button>
          } @else {
            <p class="font-semibold text-text">Todavía no hay leads.</p>
            <p class="text-muted">Cuando alguien escriba a un número de la empresa, va a aparecer acá.</p>
          }
        </div>
      } @else {
        <div class="card hidden overflow-x-auto md:block">
          <table class="w-full text-left text-sm" aria-label="Leads">
            <thead>
              <tr class="border-b border-border bg-surface-2">
                <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Contacto</th>
                <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Número</th>
                <th scope="col" class="px-4 py-2.5" [attr.aria-sort]="ariaSort(sortState(), 'score')">
                  <app-sort-header
                    column="score"
                    label="Puntaje"
                    [sort]="sortState()"
                    (sortChange)="setSort($event)"
                  />
                </th>
                <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Estado</th>
                <th scope="col" class="px-4 py-2.5" [attr.aria-sort]="ariaSort(sortState(), 'last_message')">
                  <app-sort-header
                    column="last_message"
                    label="Último mensaje"
                    [sort]="sortState()"
                    (sortChange)="setSort($event)"
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              @for (lead of rows(); track lead.id) {
                <!-- Toda la fila abre la conversación con el mouse; con teclado, el link del nombre. -->
                <tr
                  class="h-[var(--row-height)] cursor-pointer border-b border-border last:border-0 hover:bg-surface-2"
                  data-testid="lead-row"
                  (click)="openRow($event, lead.id)"
                >
                  <td class="px-4 py-2.5">
                    <a
                      class="block max-w-48 truncate font-semibold text-text hover:text-primary hover:underline"
                      [routerLink]="['/conversaciones', lead.id]"
                      >{{ name(lead) }}</a
                    >
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
                    <app-lead-state-badge [state]="lead.state" [pending]="lead.pendingHandoff" />
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
                </tr>
              }
            </tbody>
          </table>
        </div>

        <ul class="flex flex-col gap-2 md:hidden" aria-label="Leads">
          @for (lead of rows(); track lead.id) {
            <li>
              <a
                class="card flex flex-col gap-1.5 p-3.5 hover:border-border-strong"
                [routerLink]="['/conversaciones', lead.id]"
                data-testid="lead-card"
              >
                <span class="flex items-center justify-between gap-3">
                  <span class="truncate font-semibold text-text">{{ name(lead) }}</span>
                  <app-score [score]="lead.score" [level]="lead.tier" variant="compact" />
                </span>
                <span class="flex flex-wrap items-center gap-2 text-sm text-muted">
                  <span class="truncate">{{ lead.channel.name }}</span>
                  <app-lead-state-badge [state]="lead.state" [pending]="lead.pendingHandoff" />
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

        <app-paginator
          class="mt-4"
          [page]="query().page"
          [pageSize]="pageSize"
          [total]="total()"
          (pageChange)="setPage($event)"
        />
      }
    </section>
  `,
})
export class LeadsPage {
  private readonly api = inject(InboxApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly summary = inject(InboxSummary);

  private readonly params = toSignal(this.route.queryParamMap, { requireSync: true });
  protected readonly query = computed(() => parseLeadQuery(this.params()));
  protected readonly leads = query(
    () => toApiParams(this.query()),
    (params) => this.api.leads(params),
  );

  /** Lo que se ve mientras se escribe (la URL se actualiza después de una pausa). */
  protected readonly searchText = signal(this.query().q);
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly rows = computed<LeadRow[]>(() =>
    this.leads.hasValue() ? this.leads.value().items : [],
  );
  protected readonly total = computed(() => (this.leads.hasValue() ? this.leads.value().total : 0));
  protected readonly noChannels = computed(() => this.leads.hasValue() && this.leads.value().noChannels);
  protected readonly filtered = computed(() => hasFilters(this.query()));
  protected readonly sortState = computed<SortState | null>(() =>
    this.query().sort === 'default' ? null : { column: this.query().sort, direction: this.query().dir },
  );

  protected readonly pageSize = LEADS_PAGE_SIZE;
  protected readonly skeleton = [1, 2, 3, 4, 5];
  protected readonly mobileSorts = MOBILE_SORTS;
  protected readonly stateLabels = STATE_LABELS;
  protected readonly refreshIcon = RefreshCw;
  protected readonly searchIcon = Search;
  protected readonly usersIcon = Users;
  protected readonly ariaSort = ariaSort;
  protected readonly name = (lead: LeadRow) => contactName(lead.contact);
  protected readonly preview = (lead: LeadRow) => previewText(lead.lastMessage);
  protected readonly when = (iso: string) => shortWhen(iso);
  protected readonly fullWhen = fullWhen;

  /** Para lectores de pantalla: cambia solo cuando cambia el resultado, no en cada refresco. */
  protected readonly statusText = computed(() => {
    if (!this.leads.hasValue()) return '';
    const total = this.total();
    return total === 1 ? '1 lead' : `${total} leads`;
  });

  constructor() {
    pollWhileVisible(() => this.refresh());
    // "Atrás" cambia q en la URL: el campo lo sigue, salvo mientras se está escribiendo.
    effect(() => {
      const q = this.query().q;
      untracked(() => {
        if (this.searchTimer === undefined) this.searchText.set(q);
      });
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.searchTimer));
  }

  protected refresh() {
    this.leads.reload();
    this.summary.refresh();
  }

  protected onSearch(value: string) {
    this.searchText.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      this.update({ q: value, page: 0 }, true);
    }, SEARCH_DELAY_MS);
  }

  protected setFilter(key: 'tier' | 'status' | 'channel', value: string) {
    this.update({ [key]: value || null, page: 0 } as Partial<LeadQuery>);
  }

  protected setSort(sort: SortState) {
    this.update({ sort: sort.column as LeadSort, dir: sort.direction, page: 0 });
  }

  protected setMobileSort(value: string) {
    const [sort, dir] = value.split(':') as [LeadSort, 'asc' | 'desc'];
    this.update({ sort, dir, page: 0 });
  }

  protected setPage(page: number) {
    this.update({ page });
  }

  /** Clic en cualquier parte de la fila. Si fue en el link del nombre, el link ya navega. */
  protected openRow(event: MouseEvent, id: string) {
    if ((event.target as HTMLElement).closest('a')) return;
    void this.router.navigate(['/conversaciones', id]);
  }

  protected clearFilters() {
    // Una búsqueda pendiente volvería a poner el término viejo en la URL.
    clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
    this.searchText.set('');
    this.update({ ...DEFAULT_QUERY, sort: this.query().sort, dir: this.query().dir });
  }

  private update(change: Partial<LeadQuery>, replaceUrl = false) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toQueryParams({ ...this.query(), ...change }),
      replaceUrl,
    });
  }
}
