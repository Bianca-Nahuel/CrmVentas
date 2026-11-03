import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Banknote, Clock, Flame, Info, Shuffle, TriangleAlert, X } from 'lucide';
import { of } from 'rxjs';
import { FunnelApi } from '../../api/funnel-api';
import type { FunnelLossReasons, FunnelOutcome } from '../../api/generated';
import { AuthService } from '../../core/auth/auth.service';
import { can } from '../../core/nav';
import { query } from '../../core/query';
import { Icon } from '../../ui/icon';
import { Spinner } from '../../ui/spinner';
import { Paginator } from '../../ui/table';
import { amountLabel } from '../inbox/amount';
import { contactName, shortWhen } from '../inbox/format';
import { LeadTable } from '../leads/lead-table';
import { durationLabel, percentLabel, weekLabel } from '../performance/performance-format';
import { WeeklyChart, type ChartSeries } from '../performance/weekly-chart';
import { FunnelBars, type StagePick } from './funnel-bars';
import { LOW_VOLUME, OUTCOME_LABELS, listTitle, stageCount, trendPoints } from './funnel-format';
import {
  MAX_DAYS,
  PERIODS,
  PERIOD_LABELS,
  daysBetween,
  formatDay,
  funnelApiParams,
  parseFunnelQuery,
  periodRange,
  toFunnelParams,
  type FunnelPeriod,
  type FunnelQuery,
  type LeadTier,
} from './funnel-query';

const LIST_PAGE_SIZE = 25;
const STALLED_DAYS = 3;
const STALLED_PREVIEW = 5;
const MOBILE_TREND_WEEKS = 8;
const LOSS_OUTCOMES: readonly (keyof FunnelLossReasons & FunnelOutcome)[] = [
  'not_sold',
  'no_response',
  'other',
  'auto_inactive',
];
const TIER_LABELS: Record<LeadTier, string> = { hot: 'Caliente', warm: 'Tibio', cold: 'Frío' };

/**
 * Embudo de ventas (tarea 028): de la gente que escribió en el período, cuántos llegan a cada etapa, dónde se
 * pierden, cuánto tardan y cuánto se vendió. Owner, admin y viewer (metrics.read); las listas de leads, solo
 * con lead.read (el viewer ve los totales, #106). Filtros y lista abierta en la URL.
 */
@Component({
  selector: 'app-funnel-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Spinner, Paginator, LeadTable, WeeklyChart, FunnelBars],
  template: `
    <h1 class="text-2xl sm:text-[28px] sm:leading-[34px]">Embudo</h1>
    <p class="mt-1 text-muted">
      De la gente que escribió en el período, cuántos compran y en qué paso se pierden.
    </p>

    <form
      class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      (submit)="$event.preventDefault()"
      aria-label="Filtros"
    >
      <div>
        <label for="funnel-period" class="text-sm font-semibold text-muted">Período</label>
        <select
          id="funnel-period"
          class="input mt-1"
          data-testid="funnel-period"
          [value]="q().period"
          (change)="setPeriod($any($event.target).value)"
        >
          @for (period of periods; track period) {
            <option [value]="period" [selected]="period === q().period">{{ periodLabels[period] }}</option>
          }
        </select>
      </div>
      @if (q().period === 'range') {
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label for="funnel-from" class="text-sm font-semibold text-muted">Desde</label>
            <input
              id="funnel-from"
              type="date"
              class="input mt-1"
              [value]="range().from"
              [max]="range().to"
              (change)="setRange($any($event.target).value, range().to)"
            />
          </div>
          <div>
            <label for="funnel-to" class="text-sm font-semibold text-muted">Hasta</label>
            <input
              id="funnel-to"
              type="date"
              class="input mt-1"
              [value]="range().to"
              [min]="range().from"
              [max]="today"
              (change)="setRange(range().from, $any($event.target).value)"
            />
          </div>
        </div>
      }
      <div>
        <label for="funnel-channel" class="text-sm font-semibold text-muted">Número</label>
        <select
          id="funnel-channel"
          class="input mt-1"
          data-testid="funnel-channel"
          [value]="q().channel ?? ''"
          (change)="update({ channel: $any($event.target).value || null })"
        >
          <option value="">Todos los números</option>
          @for (channel of channelOptions(); track channel.id) {
            <option [value]="channel.id" [selected]="channel.id === q().channel">{{ channel.name }}</option>
          }
        </select>
      </div>
      @if (detail()) {
        <div>
          <label for="funnel-seller" class="text-sm font-semibold text-muted">Vendedor</label>
          <select
            id="funnel-seller"
            class="input mt-1"
            [value]="q().seller ?? ''"
            (change)="update({ seller: $any($event.target).value || null })"
          >
            <option value="">Todos los vendedores</option>
            @for (seller of sellerOptions(); track seller.id) {
              <option [value]="seller.id" [selected]="seller.id === q().seller">{{ seller.name }}</option>
            }
          </select>
        </div>
      }
      <div>
        <label for="funnel-tier" class="text-sm font-semibold text-muted">Nivel máximo</label>
        <select
          id="funnel-tier"
          class="input mt-1"
          [value]="q().tier ?? ''"
          (change)="update({ tier: $any($event.target).value || null })"
        >
          <option value="">Todos los niveles</option>
          @for (tier of tiers; track tier) {
            <option [value]="tier" [selected]="tier === q().tier">{{ tierLabels[tier] }}</option>
          }
        </select>
      </div>
      <label class="flex items-center gap-2.5 self-end pb-2.5 text-sm text-text">
        <input
          type="checkbox"
          class="size-5 accent-primary"
          data-testid="funnel-exclude-not-a-lead"
          [checked]="q().excludeNotALead"
          (change)="update({ excludeNotALead: $any($event.target).checked })"
        />
        Sin "no era un lead"
      </label>
    </form>
    @if (rangeTooLong()) {
      <p class="mt-2 text-sm font-medium text-error" role="alert">
        El rango puede tener hasta {{ maxDays }} días.
      </p>
    }

    @if (rangeTooLong()) {
      <!-- El aviso del rango ya está arriba: no se pide nada. -->
    } @else if (funnel.loadFailed()) {
      <div class="card mt-5 flex flex-col items-start gap-3 p-5">
        <p class="font-semibold text-text">No pudimos cargar el embudo.</p>
        <button type="button" class="btn btn-secondary btn-sm" (click)="funnel.reload()">Reintentar</button>
      </div>
    } @else if (!funnel.value()) {
      <p class="mt-5 flex items-center gap-2 text-muted" role="status"><app-spinner /> Cargando…</p>
    } @else if (funnel.value(); as data) {
      @let total = data.total;
      @if (written() === 0) {
        <div class="card mt-5 p-5" data-testid="funnel-empty">
          <p class="font-semibold text-text">No hay conversaciones nuevas en este período.</p>
          <p class="text-muted">Probá con un período más largo o sin filtros.</p>
        </div>
      } @else {
        @if (written() < lowVolume) {
          <p
            class="mt-4 flex items-start gap-2 rounded-md bg-warning-soft p-3 text-sm text-text"
            data-testid="low-volume"
          >
            <app-icon [icon]="alertIcon" [size]="16" class="mt-0.5 shrink-0 text-warning" />
            Menos de {{ lowVolume }} conversaciones: los porcentajes pueden variar mucho.
          </p>
        }
        @if (data.unattributed) {
          <p class="mt-3 flex items-start gap-2 text-sm text-muted" data-testid="unattributed">
            <app-icon [icon]="infoIcon" [size]="16" class="mt-0.5 shrink-0" />
            {{ data.unattributed }}
            {{ data.unattributed === 1 ? 'conversación atendida' : 'conversaciones atendidas' }}
            en el período no se pueden atribuir a un vendedor y no están en este embudo.
          </p>
        }

        <div class="mt-5 grid gap-5 lg:grid-cols-3">
          <section class="card p-4 sm:p-5 lg:col-span-2" aria-label="Embudo">
            <app-funnel-bars
              [block]="total"
              [canList]="canList()"
              [selected]="selectedStage()"
              (pick)="pickStage($event)"
            />
            @if (canList()) {
              <p class="mt-2 text-xs text-subtle">Tocá una etapa o una pérdida para ver esos leads.</p>
            }
          </section>

          <div class="flex flex-col gap-5">
            @if (canList()) {
              <section class="card p-4" aria-labelledby="stalled-title" data-testid="stalled">
                <h2 id="stalled-title" class="flex items-center gap-2 font-semibold text-text">
                  <app-icon [icon]="hotIcon" [size]="18" class="text-warning" /> Se están enfriando
                </h2>
                <p class="text-sm text-muted">
                  Calientes, abiertas y sin mensajes hace más de {{ stalledDays }} días.
                </p>
                @if (stalled.hasValue()) {
                  @let list = stalled.value();
                  <p class="tabular mt-2 text-2xl font-semibold text-text" data-testid="stalled-count">
                    {{ list?.total ?? 0 }}
                  </p>
                  @if (list && list.items.length > 0) {
                    <ul class="mt-2 flex flex-col divide-y divide-border text-sm">
                      @for (lead of list.items; track lead.id) {
                        <li class="flex items-center justify-between gap-2 py-1.5">
                          <a
                            class="truncate font-medium text-text hover:text-primary hover:underline"
                            [routerLink]="['/conversaciones', lead.id]"
                            >{{ name(lead.contact) }}</a
                          >
                          <span class="tabular shrink-0 text-subtle"
                            >{{ lead.score ?? '—' }} · {{ when(lead.lastMessageAt) }}</span
                          >
                        </li>
                      }
                    </ul>
                    @if (list.total > list.items.length) {
                      <button type="button" class="btn btn-ghost btn-sm mt-1" (click)="openStalled()">
                        Ver los {{ list.total }}
                      </button>
                    }
                  }
                } @else if (stalled.loadFailed()) {
                  <p class="mt-2 text-sm text-error">No pudimos cargarlos.</p>
                } @else {
                  <p class="mt-2 flex items-center gap-2 text-sm text-muted"><app-spinner /> Cargando…</p>
                }
              </section>
            }

            <section class="card p-4" aria-labelledby="amounts-title" data-testid="amounts">
              <h2 id="amounts-title" class="flex items-center gap-2 font-semibold text-text">
                <app-icon [icon]="moneyIcon" [size]="18" class="text-success" /> Montos
              </h2>
              @if (total.amounts.withAmount > 0) {
                <dl class="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <dt class="text-xs font-semibold text-muted">Total vendido</dt>
                    <dd class="tabular text-lg font-semibold text-text">{{ amount(total.amounts.total) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs font-semibold text-muted">Promedio por venta</dt>
                    <dd class="tabular text-lg font-semibold text-text">
                      {{ amount(total.amounts.average) }}
                    </dd>
                  </div>
                </dl>
              }
              <p class="mt-1 text-sm text-muted">
                @if (total.amounts.sold === 0) {
                  Todavía no hay ventas en el período.
                } @else {
                  Monto cargado en {{ total.amounts.withAmount }} de {{ total.amounts.sold }}
                  {{ total.amounts.sold === 1 ? 'venta' : 'ventas' }}.
                }
              </p>
            </section>
          </div>
        </div>

        @if (listOpen()) {
          <section class="mt-5" aria-labelledby="funnel-list-title" data-testid="funnel-list">
            <div class="flex items-center justify-between gap-2">
              <h2 id="funnel-list-title" class="text-lg font-semibold text-text">{{ listHeading() }}</h2>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                (click)="closeList()"
                aria-label="Cerrar la lista"
              >
                <app-icon [icon]="closeIcon" [size]="16" /> Cerrar
              </button>
            </div>
            @let page = listPage();
            @if (listFailed()) {
              <p class="mt-2 text-error">No pudimos cargar la lista.</p>
            } @else if (!page) {
              <p class="mt-2 flex items-center gap-2 text-muted" role="status"><app-spinner /> Cargando…</p>
            } @else if (page.items.length === 0) {
              <p class="mt-2 text-muted">No hay leads acá.</p>
            } @else {
              <div class="mt-3"><app-lead-table [rows]="page.items" [label]="listHeading()" /></div>
              <app-paginator
                class="mt-3"
                [page]="q().page"
                [pageSize]="listPageSize"
                [total]="page.total"
                (pageChange)="update({ page: $event }, false)"
              />
            }
          </section>
        }

        <div class="mt-5 grid gap-5 lg:grid-cols-2">
          <section class="card p-4 sm:p-5" aria-labelledby="loss-title" data-testid="losses">
            <h2 id="loss-title" class="font-semibold text-text">Por qué se pierden</h2>
            <p class="text-sm text-muted">
              Cerradas sin venta, por motivo. Entre paréntesis, las que habían llegado a caliente.
            </p>
            <ul class="mt-3 flex flex-col divide-y divide-border text-sm">
              @for (outcome of lossOutcomes; track outcome) {
                <li class="flex items-center justify-between gap-3 py-2">
                  @if (canList() && total.exits.lost[outcome] > 0) {
                    <button
                      type="button"
                      class="text-left text-text hover:text-primary hover:underline"
                      [attr.data-testid]="'outcome-' + outcome"
                      (click)="pickOutcome(outcome)"
                    >
                      {{ outcomeLabels[outcome] }}
                    </button>
                  } @else {
                    <span class="text-text">{{ outcomeLabels[outcome] }}</span>
                  }
                  <span class="tabular text-text">
                    {{ total.exits.lost[outcome] }}
                    <span class="text-subtle">({{ total.hotLost[outcome] }} calientes)</span>
                  </span>
                </li>
              }
              <li class="flex items-center justify-between gap-3 py-2">
                @if (canList() && total.exits.notALead > 0) {
                  <button
                    type="button"
                    class="text-left text-text hover:text-primary hover:underline"
                    (click)="pickOutcome('not_a_lead')"
                  >
                    {{ outcomeLabels.not_a_lead }}
                  </button>
                } @else {
                  <span class="text-text">{{ outcomeLabels.not_a_lead }}</span>
                }
                <span class="tabular text-text">{{ total.exits.notALead }}</span>
              </li>
              <li class="flex items-center justify-between gap-3 py-2">
                @if (canList() && total.exits.inProgress > 0) {
                  <button
                    type="button"
                    class="text-left text-text hover:text-primary hover:underline"
                    (click)="pickOutcome('open')"
                  >
                    Todavía en curso
                  </button>
                } @else {
                  <span class="text-text">Todavía en curso</span>
                }
                <span class="tabular text-text">{{ total.exits.inProgress }}</span>
              </li>
            </ul>
            <p class="mt-3 text-sm text-text" data-testid="unanswered">
              {{ total.handedOffUnanswered }}
              {{
                total.handedOffUnanswered === 1
                  ? 'derivada que nadie atendió'
                  : 'derivadas que nadie atendió'
              }}.
              <a class="font-semibold text-primary hover:underline" routerLink="/rendimiento"
                >Ver Rendimiento</a
              >
            </p>
          </section>

          <section class="card p-4 sm:p-5" aria-labelledby="times-title" data-testid="times">
            <h2 id="times-title" class="flex items-center gap-2 font-semibold text-text">
              <app-icon [icon]="clockIcon" [size]="18" /> Tiempos entre etapas
            </h2>
            <p class="text-sm text-muted">En horario de atención: mediana y el 90 % de los casos.</p>
            @if (noTimes()) {
              <p
                class="mt-2 flex items-start gap-2 rounded-md bg-surface-2 p-2.5 text-sm text-text"
                data-testid="no-times"
              >
                <app-icon [icon]="infoIcon" [size]="16" class="mt-0.5 shrink-0" />
                Todavía no hay tiempos para mostrar. Se calculan con el horario de atención de la
                configuración del agente.
              </p>
            }
            <table class="mt-2 w-full text-left text-sm">
              <thead>
                <tr class="border-b border-border">
                  <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Paso</th>
                  <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Mediana</th>
                  <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">90 %</th>
                </tr>
              </thead>
              <tbody>
                @for (row of timeRows(); track row.label) {
                  <tr class="border-b border-border last:border-0">
                    <th scope="row" class="py-1.5 pr-3 font-medium text-text">
                      {{ row.label }}
                      <span class="block text-xs font-normal text-subtle">{{ row.count }} casos</span>
                    </th>
                    <td class="tabular py-1.5 pr-3">{{ duration(row.p50) }}</td>
                    <td class="tabular py-1.5 pr-3">{{ duration(row.p90) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>

          <section class="card p-4 sm:p-5" aria-labelledby="shortcuts-title" data-testid="shortcuts">
            <h2 id="shortcuts-title" class="flex items-center gap-2 font-semibold text-text">
              <app-icon [icon]="shortcutIcon" [size]="18" /> Atajos
            </h2>
            <p class="text-sm text-muted">
              El embudo no siempre es en orden. Estos casos saltaron una etapa.
            </p>
            <dl class="mt-3 flex flex-col gap-2 text-sm">
              <div class="flex items-baseline justify-between gap-3">
                <dt class="text-text">
                  Atendidos sin derivación
                  <span class="block text-xs text-subtle"
                    >Respondió alguien del equipo sin que la IA derivara</span
                  >
                </dt>
                <dd class="tabular text-lg font-semibold text-text">
                  {{ total.shortcuts.attendedWithoutHandoff }}
                </dd>
              </div>
              <div class="flex items-baseline justify-between gap-3">
                <dt class="text-text">
                  Vendidos sin pasar por caliente
                  <span class="block text-xs text-subtle">El puntaje nunca llegó a caliente</span>
                </dt>
                <dd class="tabular text-lg font-semibold text-text">{{ total.shortcuts.soldWithoutHot }}</dd>
              </div>
              <div class="flex items-baseline justify-between gap-3">
                <dt class="text-text">
                  Vendidos solo con la IA
                  <span class="block text-xs text-subtle">Sin que respondiera nadie del equipo</span>
                </dt>
                <dd class="tabular text-lg font-semibold text-text">{{ total.shortcuts.soldAiOnly }}</dd>
              </div>
            </dl>
          </section>

          <section class="card p-4 sm:p-5" aria-labelledby="trend-title" data-testid="trend">
            <h2 id="trend-title" class="font-semibold text-text">Tendencia por semana</h2>
            @if (trendWeeks().length < 2) {
              <p class="text-sm text-muted">
                Elegí un período de al menos dos semanas (y hasta 26) para ver la tendencia.
              </p>
            } @else {
              <p class="text-sm text-muted">
                Conversión de cada cohorte semanal. Las últimas semanas todavía tienen conversaciones en
                curso.
              </p>
              <div class="mt-3 hidden md:block">
                <app-weekly-chart
                  title="Conversión a venta"
                  [weeks]="trendWeeks()"
                  [series]="trendSeries()"
                  [format]="percentShort"
                />
              </div>
              <table
                class="mt-3 w-full text-left text-sm md:hidden"
                aria-label="Conversión a venta por semana"
              >
                <thead>
                  <tr class="border-b border-border">
                    <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Semana</th>
                    <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Escribió → vendido</th>
                    <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Caliente → vendido</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of trendTable(); track row.week) {
                    <tr class="border-b border-border last:border-0">
                      <th scope="row" class="tabular py-1.5 pr-3 font-medium text-text">{{ row.week }}</th>
                      <td class="tabular py-1.5 pr-3">{{ percent(row.written) }}</td>
                      <td class="tabular py-1.5 pr-3">{{ percent(row.hot) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>
        </div>
      }
    }
  `,
})
export class FunnelPage {
  private readonly api = inject(FunnelApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);

  protected readonly periods = PERIODS;
  protected readonly periodLabels = PERIOD_LABELS;
  protected readonly tiers = Object.keys(TIER_LABELS) as LeadTier[];
  protected readonly tierLabels = TIER_LABELS;
  protected readonly lossOutcomes = LOSS_OUTCOMES;
  protected readonly outcomeLabels = OUTCOME_LABELS;
  protected readonly lowVolume = LOW_VOLUME;
  protected readonly maxDays = MAX_DAYS;
  protected readonly stalledDays = STALLED_DAYS;
  protected readonly listPageSize = LIST_PAGE_SIZE;
  protected readonly today = formatDay(new Date());
  protected readonly alertIcon = TriangleAlert;
  protected readonly infoIcon = Info;
  protected readonly hotIcon = Flame;
  protected readonly moneyIcon = Banknote;
  protected readonly clockIcon = Clock;
  protected readonly shortcutIcon = Shuffle;
  protected readonly closeIcon = X;
  protected readonly percent = percentLabel;
  protected readonly percentShort = (value: number) => `${Math.round(value)} %`;
  protected readonly duration = durationLabel;
  protected readonly amount = amountLabel;
  protected readonly name = contactName;
  protected readonly when = (iso: string) => shortWhen(iso);

  protected readonly detail = computed(() => can(this.auth.role(), { performance: ['read_detail'] }));
  /** Las listas muestran contactos y mensajes: solo con lead.read (el viewer ve los totales). */
  protected readonly canList = computed(() => can(this.auth.role(), { metrics: ['read'], lead: ['read'] }));

  private readonly params = toSignal(this.route.queryParamMap, { requireSync: true });
  protected readonly q = computed(() => parseFunnelQuery(this.params()));
  protected readonly range = computed(() => periodRange(this.q(), this.today));
  protected readonly rangeTooLong = computed(
    () => daysBetween(this.range().from, this.range().to) > MAX_DAYS,
  );

  protected readonly funnel = query(
    () => (this.rangeTooLong() ? null : funnelApiParams(this.q(), this.today, { detail: this.detail() })),
    (params) => (params ? this.api.funnel(params) : of(undefined)),
  );

  private readonly listParams = computed(() => {
    const q = this.q();
    if (!this.canList() || this.rangeTooLong() || q.stalled || (!q.stage && !q.outcome)) return null;
    const { groupBy: _groupBy, ...filters } = funnelApiParams(q, this.today, { detail: this.detail() });
    return {
      ...filters,
      ...(q.stage ? { stage: q.stage } : {}),
      ...(q.dropped ? { dropped: 'true' as const } : {}),
      ...(q.outcome ? { outcome: q.outcome } : {}),
      page: q.page,
      pageSize: LIST_PAGE_SIZE,
    };
  });
  protected readonly leads = query(
    () => this.listParams(),
    (params) => (params ? this.api.leads(params) : of(null)),
  );
  protected readonly stalled = query(
    () =>
      this.canList()
        ? {
            days: STALLED_DAYS,
            ...(this.q().channel ? { channelId: this.q().channel! } : {}),
            page: this.q().stalled ? this.q().page : 0,
            pageSize: this.q().stalled ? LIST_PAGE_SIZE : STALLED_PREVIEW,
          }
        : null,
    (params) => (params ? this.api.stalled(params) : of(null)),
  );

  protected readonly channelOptions = computed(() =>
    this.funnel.hasValue() ? this.funnel.value()!.options.channels : [],
  );
  protected readonly sellerOptions = computed(() =>
    this.funnel.hasValue() ? (this.funnel.value()!.options.sellers ?? []) : [],
  );
  protected readonly written = computed(() =>
    this.funnel.hasValue() ? stageCount(this.funnel.value()!.total, 'written') : 0,
  );
  protected readonly selectedStage = computed<StagePick | null>(() => {
    const q = this.q();
    return q.stage && !q.outcome ? { stage: q.stage, dropped: q.dropped } : null;
  });
  protected readonly listOpen = computed(
    () => this.canList() && (this.q().stalled || !!this.q().stage || !!this.q().outcome),
  );
  protected readonly listHeading = computed(() =>
    this.q().stalled ? 'Se están enfriando' : listTitle(this.q().stage, this.q().dropped, this.q().outcome),
  );
  protected readonly listPage = computed(
    () => (this.q().stalled ? this.stalled.value() : this.leads.value()) ?? null,
  );
  protected readonly listFailed = computed(() =>
    this.q().stalled ? this.stalled.loadFailed() : this.leads.loadFailed(),
  );

  protected readonly timeRows = computed(() => {
    if (!this.funnel.hasValue()) return [];
    const times = this.funnel.value()!.total.times;
    return [
      {
        label: 'Escribió → derivado',
        p50: times.toHandoff.p50Seconds,
        p90: times.toHandoff.p90Seconds,
        count: times.toHandoff.count,
      },
      {
        label: 'Derivado → atendido',
        p50: times.handoffToAttended.p50Seconds,
        p90: times.handoffToAttended.p90Seconds,
        count: times.handoffToAttended.count,
      },
      {
        label: 'Escribió → vendido',
        p50: times.toSold.p50Seconds,
        p90: times.toSold.p90Seconds,
        count: times.toSold.count,
      },
    ];
  });

  protected readonly noTimes = computed(() => this.timeRows().every((row) => row.count === 0));

  protected readonly trendWeeks = computed(() =>
    this.funnel.hasValue() ? (this.funnel.value()!.weeks ?? []).map((week) => week.weekStart) : [],
  );
  private readonly trend = computed(() =>
    trendPoints(this.funnel.hasValue() ? (this.funnel.value()!.weeks ?? []) : []),
  );
  protected readonly trendSeries = computed<ChartSeries[]>(() => [
    {
      label: 'Escribió → vendido',
      values: this.trend().map((week) => week.written),
      line: 'solid',
      marker: 'circle',
      tone: 'primary',
    },
    {
      label: 'Caliente → vendido',
      values: this.trend().map((week) => week.hot),
      line: 'dashed',
      marker: 'square',
      tone: 'warning',
    },
  ]);
  /** En el celular, una tabla corta: las últimas semanas. */
  protected readonly trendTable = computed(() =>
    this.trend()
      .slice(-MOBILE_TREND_WEEKS)
      .map((week) => ({ week: weekLabel(week.weekStart), written: week.written, hot: week.hot })),
  );

  protected setPeriod(value: string) {
    const period = (PERIODS as readonly string[]).includes(value) ? (value as FunnelPeriod) : '4w';
    // Al pasar a "un rango", arranca con el período que se estaba viendo.
    const current = this.range();
    this.update(period === 'range' ? { period, from: current.from, to: current.to } : { period });
  }

  protected setRange(from: string, to: string) {
    if (!from || !to || from > to) return;
    this.update({ period: 'range', from, to });
  }

  protected pickStage(pick: StagePick) {
    const q = this.q();
    const same = q.stage === pick.stage && q.dropped === pick.dropped && !q.outcome;
    this.update(
      {
        stage: same ? null : pick.stage,
        dropped: same ? false : pick.dropped,
        outcome: null,
        stalled: false,
      },
      false,
    );
  }

  protected pickOutcome(outcome: FunnelOutcome) {
    this.update({ stage: null, dropped: false, outcome, stalled: false }, false);
  }

  protected openStalled() {
    this.update({ stage: null, dropped: false, outcome: null, stalled: true }, false);
  }

  protected closeList() {
    this.update({ stage: null, dropped: false, outcome: null, stalled: false }, false);
  }

  /** Un filtro nuevo vuelve a la primera página de la lista. */
  protected update(change: Partial<FunnelQuery>, resetPage = true) {
    const next = { ...this.q(), ...(resetPage ? { page: 0 } : {}), ...change };
    if (change.stage !== undefined || change.outcome !== undefined || change.stalled !== undefined) {
      next.page = change.page ?? 0;
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams: toFunnelParams(next) });
  }
}
