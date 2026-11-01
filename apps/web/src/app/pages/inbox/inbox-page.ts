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
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { Clock, RefreshCw, Search } from 'lucide';
import { filter, map } from 'rxjs';
import { InboxApi } from '../../api/inbox-api';
import type { LeadRow } from '../../api/generated';
import { InboxSummary } from '../../core/inbox-summary';
import { pollWhileVisible } from '../../core/poll';
import { query } from '../../core/query';
import { Icon } from '../../ui/icon';
import { Score } from '../../ui/score';
import { contactName, previewText, shortWhen, waitingFor } from './format';
import { InboxReads } from './inbox-reads';
import { LeadStateBadge } from './lead-state-badge';

const SEARCH_DELAY_MS = 300;
const LIST_SIZE = 50;

type Attention = 'all' | 'unanswered' | 'unread';
const FILTERS: readonly { value: Attention; label: string }[] = [
  { value: 'all', label: 'Todas' },
  { value: 'unanswered', label: 'Sin responder' },
  { value: 'unread', label: 'Sin ver' },
];

/**
 * Bandeja (tarea 014): lista de conversaciones por prioridad (decisión #82: primero las que esperan a una
 * persona del equipo; después calor y espera por igual) y la conversación elegida. Filtros "Sin responder"
 * y "Sin ver" (por usuario). En el escritorio, dos paneles; en el celular, la lista o la conversación a
 * pantalla completa. Se refresca sola cada 30 s con la pestaña visible (el tiempo real llega en la 025).
 */
@Component({
  selector: 'app-inbox-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterOutlet, Icon, Score, LeadStateBadge],
  host: { class: 'block lg:h-[calc(100dvh-8rem)]' },
  template: `
    <h1 class="sr-only">Conversaciones</h1>
    <div
      class="lg:grid lg:h-full lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-4 xl:grid-cols-[300px_minmax(0,1fr)]"
    >
      <section
        class="flex min-h-0 flex-col lg:rounded-lg lg:border lg:border-border lg:bg-surface lg:shadow-1 lg:overflow-hidden"
        [class.max-lg:hidden]="selectedId()"
        aria-label="Lista de conversaciones"
      >
        <div class="flex items-center justify-between gap-2 lg:px-3 lg:pt-3">
          <p class="text-2xl font-semibold text-text lg:text-lg" aria-hidden="true">Conversaciones</p>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (click)="refresh()"
            [disabled]="list.isLoading()"
          >
            <app-icon [icon]="refreshIcon" [size]="16" /><span class="sr-only">Actualizar</span>
          </button>
        </div>
        <div class="relative mt-3 lg:mx-3">
          <label for="inbox-q" class="sr-only">Buscar conversación</label>
          <app-icon
            [icon]="searchIcon"
            [size]="17"
            class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle"
          />
          <input
            id="inbox-q"
            class="input pl-9"
            type="search"
            autocomplete="off"
            maxlength="100"
            placeholder="Buscar por nombre o número"
            (input)="onSearch($any($event.target).value)"
          />
        </div>
        <div class="mt-2 flex gap-1 lg:mx-3" role="group" aria-label="Filtrar conversaciones">
          @for (option of filters; track option.value) {
            <button
              type="button"
              class="h-8 rounded-full border px-3 text-sm font-medium"
              [class]="
                attention() === option.value
                  ? 'border-primary bg-primary-soft text-primary-strong'
                  : 'border-border text-muted hover:bg-surface-2 hover:text-text'
              "
              [attr.aria-pressed]="attention() === option.value"
              (click)="attention.set(option.value)"
            >
              {{ option.label }}
            </button>
          }
        </div>

        <div class="mt-3 min-h-0 flex-1 lg:overflow-y-auto" [attr.aria-busy]="list.isLoading()">
          @if (list.loadFailed()) {
            <div class="p-4">
              <p class="font-semibold text-text">No pudimos cargar las conversaciones.</p>
              <button type="button" class="btn btn-secondary btn-sm mt-2" (click)="refresh()">
                Reintentar
              </button>
            </div>
          } @else if (!list.hasValue()) {
            <p class="p-4 text-muted">Cargando…</p>
          } @else if (rows().length === 0) {
            <div class="p-4" data-testid="inbox-empty">
              @if (list.value().noChannels) {
                <p class="font-semibold text-text">Todavía no tenés números asignados.</p>
                <p class="mt-1 text-muted">
                  Vas a ver acá las conversaciones de los números que te asigne un administrador.
                </p>
              } @else {
                <p class="text-muted">{{ emptyText() }}</p>
              }
            </div>
          } @else {
            <ul class="flex flex-col gap-2 lg:gap-0 lg:divide-y lg:divide-border">
              @for (row of rows(); track row.id) {
                <li>
                  <a
                    class="flex flex-col gap-1 p-3.5 hover:bg-surface-2 max-lg:rounded-lg max-lg:border max-lg:border-border max-lg:bg-surface max-lg:shadow-1"
                    [class.bg-primary-soft]="row.id === selectedId()"
                    [attr.aria-current]="row.id === selectedId() ? 'page' : null"
                    [routerLink]="['/conversaciones', row.id]"
                    data-testid="inbox-item"
                  >
                    <span class="flex items-center justify-between gap-2">
                      <span class="flex min-w-0 items-center gap-2">
                        @if (row.unread) {
                          <span
                            class="size-2 shrink-0 rounded-full bg-primary"
                            data-testid="unread-dot"
                          ></span>
                          <span class="sr-only">Sin ver.</span>
                        }
                        <span
                          class="truncate text-text"
                          [class]="row.unread ? 'font-bold' : 'font-semibold'"
                          >{{ name(row) }}</span
                        >
                      </span>
                      <time
                        class="tabular shrink-0 text-xs text-subtle"
                        [attr.datetime]="row.lastMessageAt"
                        >{{ when(row.lastMessageAt) }}</time
                      >
                    </span>
                    <span
                      class="truncate text-sm"
                      [class]="row.unread ? 'font-medium text-text' : 'text-muted'"
                      >{{ preview(row) }}</span
                    >
                    @if (row.awaitingReply && row.waitingSince) {
                      <span
                        class="inline-flex items-center gap-1 text-xs font-semibold text-warning"
                        data-testid="waiting"
                      >
                        <app-icon [icon]="clockIcon" [size]="13" /> Espera respuesta hace
                        {{ waiting(row.waitingSince) }}
                      </span>
                    }
                    <span class="flex items-center justify-between gap-2">
                      <app-lead-state-badge [state]="row.state" [pending]="row.pendingHandoff" />
                      <app-score [score]="row.score" [level]="row.tier" variant="compact" />
                    </span>
                  </a>
                </li>
              }
            </ul>
            @if (list.value().total > rows().length) {
              <p class="p-3.5 text-sm text-muted">
                Se muestran las {{ rows().length }} más recientes de {{ list.value().total }}.
                <a class="font-semibold text-primary hover:underline" routerLink="/leads"
                  >Ver todas en Leads</a
                >
              </p>
            }
          }
        </div>
      </section>

      <section
        class="min-h-0 lg:rounded-lg lg:border lg:border-border lg:bg-surface lg:shadow-1 lg:overflow-hidden"
        [class.max-lg:hidden]="!selectedId()"
        aria-label="Conversación"
      >
        <router-outlet />
      </section>
    </div>
  `,
})
export class InboxPage {
  private readonly api = inject(InboxApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly summary = inject(InboxSummary);

  private readonly reads = inject(InboxReads);

  protected readonly query = signal('');
  protected readonly attention = signal<Attention>('all');
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly list = query(
    () => {
      const q = this.query().trim();
      return {
        sort: 'priority' as const,
        dir: 'desc' as const,
        pageSize: LIST_SIZE,
        ...(q.length >= 2 ? { q } : {}),
        ...(this.attention() === 'all' ? {} : { attention: this.attention() as 'unanswered' | 'unread' }),
      };
    },
    (params) => this.api.leads(params),
  );
  protected readonly rows = computed<LeadRow[]>(() => (this.list.hasValue() ? this.list.value().items : []));

  protected readonly selectedId = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.childId()),
    ),
    { initialValue: this.childId() },
  );

  protected readonly emptyText = computed(() => {
    if (this.attention() === 'unanswered') return 'No hay conversaciones esperando respuesta.';
    if (this.attention() === 'unread') return 'No hay conversaciones sin ver.';
    return this.query() ? 'No hay conversaciones con esa búsqueda.' : 'No hay conversaciones.';
  });

  protected readonly filters = FILTERS;
  protected readonly clockIcon = Clock;
  protected readonly waiting = (iso: string) => waitingFor(iso);
  protected readonly refreshIcon = RefreshCw;
  protected readonly searchIcon = Search;
  protected readonly name = (row: LeadRow) => contactName(row.contact);
  protected readonly preview = (row: LeadRow) => previewText(row.lastMessage);
  protected readonly when = (iso: string) => shortWhen(iso);

  constructor() {
    pollWhileVisible(() => this.refresh());
    inject(DestroyRef).onDestroy(() => clearTimeout(this.searchTimer));
    // Al abrir una conversación se marca como vista: se le saca el "sin ver" sin volver a pedir la lista
    // (con el filtro "Sin ver" queda hasta el próximo refresco, para no mover la lista bajo el cursor).
    effect(() => {
      const read = this.reads.lastRead();
      if (!read) return;
      untracked(() =>
        this.list.update((list) =>
          list
            ? {
                ...list,
                items: list.items.map((row) => (row.id === read.id ? { ...row, unread: false } : row)),
              }
            : list,
        ),
      );
    });
  }

  protected refresh() {
    this.list.reload();
    this.summary.refresh();
  }

  protected onSearch(value: string) {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.query.set(value), SEARCH_DELAY_MS);
  }

  private childId(): string | null {
    // Mientras se crea la página, la ruta hija todavía no tiene snapshot: llega con el NavigationEnd.
    return this.route.firstChild?.snapshot?.paramMap.get('id') ?? null;
  }
}
