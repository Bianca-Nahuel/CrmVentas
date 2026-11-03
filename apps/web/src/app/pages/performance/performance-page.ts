import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide';
import { of } from 'rxjs';
import { PerformanceApi } from '../../api/performance-api';
import type {
  ChannelWeeks,
  CustomerOutcome,
  IssueType,
  ReviewRow,
  SellerWeeks,
  WeekMetrics,
} from '../../api/generated';
import { AuthService } from '../../core/auth/auth.service';
import { can } from '../../core/nav';
import { query } from '../../core/query';
import { Icon } from '../../ui/icon';
import { Paginator } from '../../ui/table';
import { fullWhen } from '../inbox/format';
import {
  CUSTOMER_OUTCOME_LABELS,
  ISSUE_LABELS,
  WEEK_RANGES,
  delta,
  durationLabel,
  percentLabel,
  scoreLabel,
  weekLabel,
  type Delta,
  type WeekRange,
} from './performance-format';
import { WeeklyChart, type ChartSeries } from './weekly-chart';
import { Spinner } from '../../ui/spinner';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const REVIEWS_PAGE_SIZE = 10;
const OUTCOMES = Object.keys(CUSTOMER_OUTCOME_LABELS) as CustomerOutcome[];
const ISSUES = Object.keys(ISSUE_LABELS) as IssueType[];

interface PerformanceQuery {
  weeks: WeekRange;
  channel: string | null;
  seller: string | null;
  outcome: CustomerOutcome | null;
  issue: IssueType | null;
  criterion: string | null;
  reviewPage: number;
}

/** AAAA-MM-DD de hoy (navegador); la API toma el lunes de esa semana en la zona de la empresa. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

const toMinutes = (seconds: number | null) => (seconds === null ? null : Math.round(seconds / 6) / 10);

interface Metric {
  label: string;
  value: string;
  delta: Delta;
  detail?: string;
}

/**
 * Rendimiento (tarea 026): métricas semanales por número, por vendedor y revisiones de calidad. Owner y
 * admin ven todo; el viewer, los totales por número (la API devuelve null en lo demás). Filtros en la URL.
 */
@Component({
  selector: 'app-performance-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Paginator, WeeklyChart, Spinner],
  template: `
    <h1 class="text-2xl sm:text-[28px] sm:leading-[34px]">Rendimiento</h1>

    <form class="mt-4 grid gap-3 sm:grid-cols-3" (submit)="$event.preventDefault()" aria-label="Filtros">
      <div>
        <label for="perf-weeks" class="text-sm font-semibold text-muted">Semanas</label>
        <select
          id="perf-weeks"
          class="input mt-1"
          [value]="q().weeks"
          (change)="setWeeks($any($event.target).value)"
        >
          @for (range of ranges; track range) {
            <option [value]="range">Últimas {{ range }}</option>
          }
        </select>
      </div>
      <div>
        <label for="perf-channel" class="text-sm font-semibold text-muted">Número</label>
        <select
          id="perf-channel"
          class="input mt-1"
          [value]="q().channel ?? ''"
          (change)="update({ channel: $any($event.target).value || null, reviewPage: 0 })"
        >
          <option value="">Todos los números</option>
          @for (channel of channelOptions(); track channel.id) {
            <option [value]="channel.id">{{ channel.name }}</option>
          }
        </select>
      </div>
      @if (detail()) {
        <div>
          <label for="perf-seller" class="text-sm font-semibold text-muted">Vendedor</label>
          <select
            id="perf-seller"
            class="input mt-1"
            [value]="q().seller ?? ''"
            (change)="update({ seller: $any($event.target).value || null, reviewPage: 0 })"
          >
            <option value="">Todos los vendedores</option>
            @for (seller of sellerOptions(); track seller.id) {
              <option [value]="seller.id">{{ seller.name }}</option>
            }
          </select>
        </div>
      }
    </form>

    @if (weekly.loadFailed()) {
      <div class="card mt-5 flex flex-col items-start gap-3 p-5">
        <p class="font-semibold text-text">No pudimos cargar el rendimiento.</p>
        <button type="button" class="btn btn-secondary btn-sm" (click)="weekly.reload()">Reintentar</button>
      </div>
    } @else if (!weekly.hasValue()) {
      <p class="flex items-center gap-2 mt-5 text-muted" role="status"><app-spinner /> Cargando…</p>
    } @else {
      <section class="mt-5" aria-labelledby="perf-cards-title">
        <h2 id="perf-cards-title" class="text-lg font-semibold text-text">
          {{ weekTitle() }} <span class="text-sm font-normal text-muted">· contra la semana anterior</span>
        </h2>
        <div class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          @for (item of channels(); track item.channel.id) {
            <article class="card p-4" data-testid="channel-card" [attr.aria-label]="item.channel.name">
              <h3 class="truncate font-semibold text-text">{{ item.channel.name }}</h3>
              @if (item.channel.phoneNumber) {
                <p class="tabular text-sm text-subtle">{{ item.channel.phoneNumber }}</p>
              }
              <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-3">
                @for (metric of cardMetrics(item); track metric.label) {
                  <div>
                    <dt class="text-xs font-semibold text-muted">{{ metric.label }}</dt>
                    <dd class="tabular text-lg font-semibold text-text">{{ metric.value }}</dd>
                    @if (metric.delta.direction !== 'none') {
                      <dd
                        class="flex items-center gap-1 text-xs"
                        [class]="
                          metric.delta.good === null
                            ? 'text-muted'
                            : metric.delta.good
                              ? 'text-success'
                              : 'text-warning'
                        "
                      >
                        <app-icon [icon]="deltaIcon(metric.delta)" [size]="13" />
                        {{ metric.delta.text }}
                      </dd>
                    }
                    @if (metric.detail) {
                      <dd class="text-xs text-subtle">{{ metric.detail }}</dd>
                    }
                  </div>
                }
              </dl>
            </article>
          } @empty {
            <p class="text-muted">Todavía no hay números conectados.</p>
          }
        </div>
      </section>

      <section class="card mt-5 p-4" aria-label="Evolución semanal">
        <app-weekly-chart
          title="Atendidas y cerradas"
          [weeks]="weekly.value().weeks"
          [series]="countSeries()"
        />
        @if (responseSeries(); as series) {
          <div class="mt-5 border-t border-border pt-4">
            <app-weekly-chart
              title="Primera respuesta después de derivar (horario de atención)"
              [weeks]="weekly.value().weeks"
              [series]="series"
              [format]="minutes"
            />
          </div>
        } @else {
          <p class="mt-4 text-sm text-muted">Elegí un número para ver el tiempo de respuesta por semana.</p>
        }
      </section>

      @if (weekly.value().sellers; as sellers) {
        <section class="mt-5" aria-labelledby="perf-sellers-title">
          <h2 id="perf-sellers-title" class="text-lg font-semibold text-text">
            Por vendedor · {{ weekTitle() }}
          </h2>
          @for (note of unattributedNotes(); track note) {
            <p class="mt-2 text-sm text-muted" data-testid="unattributed">{{ note }}</p>
          }
          @if (sellers.length === 0) {
            <p class="mt-2 text-muted">No hay conversaciones atribuibles a un vendedor en estas semanas.</p>
          } @else {
            <div class="card mt-3 hidden overflow-x-auto md:block">
              <table class="w-full text-left text-sm" aria-label="Rendimiento por vendedor">
                <thead>
                  <tr class="border-b border-border bg-surface-2">
                    <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Vendedor</th>
                    <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Atendidas</th>
                    <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Cerradas</th>
                    <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Derivadas sin respuesta</th>
                    <th scope="col" class="px-4 py-2.5 font-semibold text-muted">
                      1.ª respuesta (mediana · p90)
                    </th>
                    <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Satisfacción</th>
                    <th scope="col" class="px-4 py-2.5 font-semibold text-muted">Calidad</th>
                  </tr>
                </thead>
                <tbody>
                  @for (seller of sellers; track seller.user.id) {
                    @let w = current(seller);
                    <tr class="border-b border-border last:border-0" data-testid="seller-row">
                      <th scope="row" class="px-4 py-2.5 font-semibold text-text">{{ seller.user.name }}</th>
                      <td class="tabular px-4">{{ w?.attended ?? 0 }}</td>
                      <td class="tabular px-4">{{ w?.closed?.total ?? 0 }}</td>
                      <td class="tabular px-4">{{ w?.handedOffUnanswered ?? 0 }}</td>
                      <td class="tabular px-4">
                        {{ duration(w?.handoffResponse?.p50Seconds) }} ·
                        {{ duration(w?.handoffResponse?.p90Seconds) }}
                      </td>
                      <td class="tabular px-4">{{ percent(w?.quality?.satisfiedPct) }}</td>
                      <td class="tabular px-4">{{ score(w?.quality?.average) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <ul class="mt-3 flex flex-col gap-2 md:hidden" aria-label="Rendimiento por vendedor">
              @for (seller of sellers; track seller.user.id) {
                @let w = current(seller);
                <li class="card p-3.5" data-testid="seller-card">
                  <p class="font-semibold text-text">{{ seller.user.name }}</p>
                  <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                    <dt class="text-muted">Atendidas</dt>
                    <dd class="tabular text-text">{{ w?.attended ?? 0 }}</dd>
                    <dt class="text-muted">Cerradas</dt>
                    <dd class="tabular text-text">{{ w?.closed?.total ?? 0 }}</dd>
                    <dt class="text-muted">Sin respuesta</dt>
                    <dd class="tabular text-text">{{ w?.handedOffUnanswered ?? 0 }}</dd>
                    <dt class="text-muted">1.ª respuesta</dt>
                    <dd class="tabular text-text">{{ duration(w?.handoffResponse?.p50Seconds) }}</dd>
                    <dt class="text-muted">Satisfacción</dt>
                    <dd class="tabular text-text">{{ percent(w?.quality?.satisfiedPct) }}</dd>
                    <dt class="text-muted">Calidad</dt>
                    <dd class="tabular text-text">{{ score(w?.quality?.average) }}</dd>
                  </dl>
                </li>
              }
            </ul>
          }
        </section>
      }

      @if (detail()) {
        <section class="mt-6" aria-labelledby="perf-reviews-title">
          <h2 id="perf-reviews-title" class="text-lg font-semibold text-text">Revisiones de calidad</h2>
          <form
            class="mt-3 grid gap-3 sm:grid-cols-3"
            (submit)="$event.preventDefault()"
            aria-label="Filtros de revisiones"
          >
            <div>
              <label for="rev-outcome" class="sr-only">Resultado del cliente</label>
              <select
                id="rev-outcome"
                class="input"
                [value]="q().outcome ?? ''"
                (change)="update({ outcome: $any($event.target).value || null, reviewPage: 0 })"
              >
                <option value="">Todos los resultados del cliente</option>
                @for (outcome of outcomes; track outcome) {
                  <option [value]="outcome">Cliente: {{ outcomeLabels[outcome] }}</option>
                }
              </select>
            </div>
            <div>
              <label for="rev-issue" class="sr-only">Problema</label>
              <select
                id="rev-issue"
                class="input"
                [value]="q().issue ?? ''"
                (change)="update({ issue: $any($event.target).value || null, reviewPage: 0 })"
              >
                <option value="">Todos los problemas</option>
                @for (issue of issues; track issue) {
                  <option [value]="issue">{{ issueLabels[issue] }}</option>
                }
              </select>
            </div>
            <div>
              <label for="rev-criterion" class="sr-only">Criterio con nota baja</label>
              <select
                id="rev-criterion"
                class="input"
                [value]="q().criterion ?? ''"
                (change)="update({ criterion: $any($event.target).value || null, reviewPage: 0 })"
              >
                <option value="">Cualquier nota</option>
                @for (criterion of criteria(); track criterion.key) {
                  <option [value]="criterion.key">Nota baja en {{ criterion.label }}</option>
                }
              </select>
            </div>
          </form>

          @if (reviews.value(); as list) {
            @if (list.items.length === 0) {
              <p class="mt-3 text-muted" data-testid="reviews-empty">No hay revisiones con estos filtros.</p>
            } @else {
              <ul class="mt-3 flex flex-col gap-2" aria-label="Revisiones">
                @for (review of list.items; track review.id) {
                  <li>
                    <a
                      class="card flex flex-col gap-1 p-3.5 hover:border-border-strong"
                      [routerLink]="['/rendimiento/revisiones', review.id]"
                      data-testid="review-row"
                    >
                      <span class="flex flex-wrap items-center justify-between gap-2">
                        <span class="font-semibold text-text">
                          Cliente: {{ outcomeLabels[review.customerOutcome] }}
                          @if (review.disputed) {
                            <span class="ml-1 text-sm font-normal text-muted"
                              >· marcada como no correcta</span
                            >
                          }
                        </span>
                        <span class="tabular text-sm text-subtle">{{ when(review.lastMessageAt) }}</span>
                      </span>
                      <span class="text-sm text-muted">
                        {{ review.channel.name }}{{ review.seller ? ' · ' + review.seller.name : '' }} ·
                        Calidad
                        {{ score(review.average) }}
                      </span>
                      @if (review.issueTypes.length) {
                        <span class="text-sm text-text">{{ issueList(review) }}</span>
                      }
                      <span class="line-clamp-2 text-sm text-muted">{{ review.summary }}</span>
                    </a>
                  </li>
                }
              </ul>
              <app-paginator
                class="mt-3"
                [page]="q().reviewPage"
                [pageSize]="reviewsPageSize"
                [total]="list.total"
                (pageChange)="update({ reviewPage: $event })"
              />
            }
          }
        </section>

        @if (digests.value()?.items?.length) {
          <section class="mt-6" aria-labelledby="perf-digests-title">
            <h2 id="perf-digests-title" class="text-lg font-semibold text-text">Resumen semanal</h2>
            <div class="mt-3 grid gap-3 md:grid-cols-2">
              @for (digest of digests.value()!.items; track digest.id) {
                <article class="card p-4 text-sm">
                  <h3 class="font-semibold text-text">
                    {{ digest.channel.name }} · {{ long(digest.weekStart) }}
                  </h3>
                  <p class="mt-2 text-text">{{ digest.improved }}</p>
                  @if (digest.frequentProblems.length) {
                    <ul class="mt-2 list-disc pl-5 text-text">
                      @for (problem of digest.frequentProblems; track $index) {
                        <li>{{ problem }}</li>
                      }
                    </ul>
                  }
                  @for (example of digest.examples; track example.reviewId) {
                    <p class="mt-2">
                      <a
                        class="text-primary hover:underline"
                        [routerLink]="['/rendimiento/revisiones', example.reviewId]"
                        >Ver ejemplo</a
                      >
                      <span class="text-muted"> · {{ example.why }}</span>
                    </p>
                  }
                </article>
              }
            </div>
          </section>
        }
      }
    }
  `,
})
export class PerformancePage {
  private readonly api = inject(PerformanceApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap, { requireSync: true });

  protected readonly detail = computed(() => can(this.auth.role(), { performance: ['read_detail'] }));
  protected readonly q = computed<PerformanceQuery>(() => {
    const p = this.params();
    const weeks = Number(p.get('weeks'));
    const pick = <T extends string>(value: string | null, options: readonly T[]) =>
      value !== null && (options as readonly string[]).includes(value) ? (value as T) : null;
    const id = (value: string | null) => (value && UUID.test(value) ? value : null);
    const page = Number(p.get('rpage'));
    return {
      weeks: (WEEK_RANGES as readonly number[]).includes(weeks) ? (weeks as WeekRange) : 8,
      channel: id(p.get('channel')),
      seller: id(p.get('seller')),
      outcome: pick(p.get('outcome'), OUTCOMES),
      issue: pick(p.get('issue'), ISSUES),
      criterion: KEY.test(p.get('criterion') ?? '') ? p.get('criterion') : null,
      reviewPage: Number.isInteger(page) && page > 0 && page <= 10_000 ? page : 0,
    };
  });
  private readonly range = computed(() => {
    const to = today();
    return { from: daysBefore(to, (this.q().weeks - 1) * 7), to };
  });

  protected readonly weekly = query(
    () => ({
      ...this.range(),
      ...(this.q().channel ? { channelId: this.q().channel! } : {}),
      ...(this.detail() && this.q().seller ? { userId: this.q().seller! } : {}),
    }),
    (params) => this.api.weekly(params),
  );
  protected readonly reviews = query(
    () =>
      this.detail()
        ? {
            ...this.range(),
            ...(this.q().channel ? { channelId: this.q().channel! } : {}),
            ...(this.q().seller ? { userId: this.q().seller! } : {}),
            ...(this.q().outcome ? { outcome: this.q().outcome! } : {}),
            ...(this.q().issue ? { issue: this.q().issue! } : {}),
            ...(this.q().criterion ? { lowCriterion: this.q().criterion! } : {}),
            page: this.q().reviewPage,
            pageSize: REVIEWS_PAGE_SIZE,
          }
        : null,
    // Sin read_detail no se pide nada (la API respondería 403).
    (params) => (params ? this.api.reviews(params) : of(null)),
  );
  protected readonly digests = query(
    () =>
      this.detail()
        ? { ...this.range(), ...(this.q().channel ? { channelId: this.q().channel! } : {}) }
        : null,
    (params) => (params ? this.api.digests(params) : of(null)),
  );

  protected readonly channels = computed<ChannelWeeks[]>(() =>
    this.weekly.hasValue() ? this.weekly.value().channels : [],
  );
  protected readonly channelOptions = computed(() =>
    this.weekly.hasValue() ? this.weekly.value().options.channels : [],
  );
  protected readonly sellerOptions = computed(() =>
    this.weekly.hasValue() ? (this.weekly.value().options.sellers ?? []) : [],
  );
  protected readonly weekTitle = computed(() => {
    const weeks = this.weekly.hasValue() ? this.weekly.value().weeks : [];
    return weeks.length ? weekLabel(weeks.at(-1)!, true) : '';
  });
  /** Criterios de la config vigente (salen de cualquier semana con calidad). */
  protected readonly criteria = computed(() => {
    const week = this.channels()[0]?.weeks.at(-1);
    return week?.quality?.criteria ?? [];
  });

  protected readonly countSeries = computed<ChartSeries[]>(() => {
    const sum = (pick: (week: WeekMetrics) => number) =>
      (this.weekly.hasValue() ? this.weekly.value().weeks : []).map((_, index) =>
        this.channels().reduce((total, item) => total + pick(item.weeks[index]!), 0),
      );
    return [
      {
        label: 'Atendidas',
        values: sum((week) => week.attended),
        line: 'solid',
        marker: 'circle',
        tone: 'primary',
      },
      {
        // Las que cerró una persona: sin las que se cerraron solas por inactividad (van en su propia línea).
        label: 'Cerradas',
        values: sum((week) => week.closed.total - week.closed.auto_inactive),
        line: 'dashed',
        marker: 'square',
        tone: 'warning',
      },
      {
        label: 'Cerradas automáticamente',
        values: sum((week) => week.closed.auto_inactive),
        line: 'dotted',
        marker: 'triangle',
        tone: 'muted',
      },
    ];
  });
  /** El tiempo de respuesta no se suma entre números: se muestra con un número elegido. */
  protected readonly responseSeries = computed<ChartSeries[] | null>(() => {
    if (!this.q().channel || this.channels().length !== 1) return null;
    const weeks = this.channels()[0]!.weeks;
    return [
      // En minutos: el eje queda en números redondos.
      {
        label: 'Mediana',
        values: weeks.map((week) => toMinutes(week.handoffResponse.p50Seconds)),
        line: 'solid',
        marker: 'circle',
        tone: 'primary',
      },
      {
        label: 'Percentil 90',
        values: weeks.map((week) => toMinutes(week.handoffResponse.p90Seconds)),
        line: 'dotted',
        marker: 'triangle',
        tone: 'muted',
      },
    ];
  });
  protected readonly unattributedNotes = computed(() =>
    this.channels()
      .map((item) => ({ item, week: item.weeks.at(-1) }))
      .filter(({ week }) => (week?.unattributed ?? 0) > 0)
      .map(({ item, week }) => {
        const n = week!.unattributed!;
        const sellers = item.sellersCount ?? 0;
        const why =
          sellers > 1
            ? `el número tiene ${sellers} vendedores y responden desde el teléfono`
            : 'el número no tiene un solo vendedor asignado';
        return `${item.channel.name}: ${n} ${n === 1 ? 'conversación atendida no se puede atribuir' : 'conversaciones atendidas no se pueden atribuir'} (${why}).`;
      }),
  );

  protected readonly ranges = WEEK_RANGES;
  protected readonly outcomes = OUTCOMES;
  protected readonly issues = ISSUES;
  protected readonly outcomeLabels = CUSTOMER_OUTCOME_LABELS;
  protected readonly issueLabels = ISSUE_LABELS;
  protected readonly reviewsPageSize = REVIEWS_PAGE_SIZE;
  protected readonly duration = durationLabel;
  protected readonly minutes = (value: number) => `${Math.round(value)} min`;
  protected readonly percent = percentLabel;
  protected readonly score = scoreLabel;
  protected readonly when = fullWhen;
  protected readonly long = (week: string) => weekLabel(week, true);
  protected readonly current = (seller: SellerWeeks) => seller.weeks.at(-1);
  protected readonly issueList = (review: ReviewRow) =>
    review.issueTypes.map((type) => ISSUE_LABELS[type]).join(' · ');

  protected deltaIcon(value: Delta) {
    return value.direction === 'up' ? ArrowUpRight : value.direction === 'down' ? ArrowDownRight : Minus;
  }

  protected cardMetrics(item: ChannelWeeks): Metric[] {
    const now = item.weeks.at(-1);
    const before = item.weeks.at(-2);
    if (!now) return [];
    const closed = now.closed;
    const metrics: Metric[] = [
      { label: 'Atendidas', value: String(now.attended), delta: delta(now.attended, before?.attended, true) },
      {
        label: 'Cerradas',
        value: String(closed.total),
        delta: delta(closed.total, before?.closed.total, true),
        detail: closed.total ? `${closed.sold} vendidas · ${closed.not_sold} no compraron` : undefined,
      },
      {
        label: 'Derivadas sin respuesta',
        value: String(now.handedOffUnanswered),
        delta: delta(now.handedOffUnanswered, before?.handedOffUnanswered, false),
      },
      {
        label: '1.ª respuesta tras derivar',
        value: durationLabel(now.handoffResponse.p50Seconds),
        delta: delta(
          now.handoffResponse.p50Seconds,
          before?.handoffResponse.p50Seconds,
          false,
          durationLabel,
        ),
        detail:
          now.handoffResponse.p90Seconds !== null
            ? `p90: ${durationLabel(now.handoffResponse.p90Seconds)}`
            : undefined,
      },
    ];
    if (now.quality) {
      metrics.push(
        {
          label: 'Satisfacción',
          value: percentLabel(now.quality.satisfiedPct),
          delta: delta(now.quality.satisfiedPct, before?.quality?.satisfiedPct, true, (v) => percentLabel(v)),
          detail: `${now.quality.reviews} ${now.quality.reviews === 1 ? 'revisión' : 'revisiones'}`,
        },
        {
          label: 'Calidad promedio',
          value: scoreLabel(now.quality.average),
          delta: delta(now.quality.average, before?.quality?.average, true, scoreLabel),
        },
      );
    }
    return metrics;
  }

  protected setWeeks(value: string) {
    const weeks = Number(value);
    if ((WEEK_RANGES as readonly number[]).includes(weeks)) this.update({ weeks: weeks as WeekRange });
  }

  protected update(change: Partial<PerformanceQuery>) {
    const next = { ...this.q(), ...change };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        weeks: next.weeks === 8 ? null : next.weeks,
        channel: next.channel,
        seller: next.seller,
        outcome: next.outcome,
        issue: next.issue,
        criterion: next.criterion,
        rpage: next.reviewPage || null,
      },
    });
  }
}
