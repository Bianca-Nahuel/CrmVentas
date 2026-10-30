import { BreakpointObserver } from '@angular/cdk/layout';
import { CdkTableModule } from '@angular/cdk/table';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DatePipe, DecimalPipe } from '@angular/common';
import { CircleAlert, CircleCheck, Search, TriangleAlert } from 'lucide';
import { map } from 'rxjs';
import { Button } from '../ui/button';
import { BrandMark } from '../ui/brand-mark';
import { Field } from '../ui/field';
import { Icon } from '../ui/icon';
import { Score, type LeadLevel } from '../ui/score';
import { Paginator, SortHeader, ariaSort, type SortState } from '../ui/table';
import { TagList, Tag, type TagTone } from '../ui/tag';
import { ThemeService, type ThemePreference } from '../ui/theme.service';

interface DemoLead {
  id: string;
  name: string;
  score: number | null;
  level: LeadLevel | null;
  tags: { label: string; tone?: TagTone }[];
  lastMessageAt: Date;
}

// Datos inventados para mostrar los componentes. Nada de esto sale de la base.
const now = Date.now();
const DEMO_LEADS: DemoLead[] = [
  {
    id: '1',
    name: 'Cliente de ejemplo 1',
    score: 92,
    level: 'hot',
    tags: [
      { label: 'Porcelanato', tone: 'primary' },
      { label: 'Obra nueva' },
      { label: 'Pide visita', tone: 'hot' },
      { label: 'Zona norte' },
    ],
    lastMessageAt: new Date(now - 4 * 60_000),
  },
  {
    id: '2',
    name: 'Cliente de ejemplo 2',
    score: 71,
    level: 'warm',
    tags: [{ label: 'Revestimiento' }, { label: 'Compara precios', tone: 'warm' }],
    lastMessageAt: new Date(now - 38 * 60_000),
  },
  {
    id: '3',
    name: 'Cliente de ejemplo 3',
    score: 64,
    level: 'warm',
    tags: [{ label: 'Baño' }],
    lastMessageAt: new Date(now - 3 * 3_600_000),
  },
  {
    id: '4',
    name: 'Cliente de ejemplo 4',
    score: 23,
    level: 'cold',
    tags: [{ label: 'Solo consulta', tone: 'cold' }],
    lastMessageAt: new Date(now - 26 * 3_600_000),
  },
  {
    id: '5',
    name: 'Cliente de ejemplo con un nombre bastante largo',
    score: null,
    level: null,
    tags: [],
    lastMessageAt: new Date(now - 50 * 3_600_000),
  },
];

const SWATCHES = [
  ['--primary', 'Primario'],
  ['--primary-soft', 'Primario suave'],
  ['--surface', 'Superficie'],
  ['--surface-2', 'Superficie 2'],
  ['--bg', 'Fondo'],
  ['--text', 'Texto'],
  ['--text-muted', 'Texto secundario'],
  ['--border', 'Borde'],
  ['--border-strong', 'Borde de control'],
  ['--success', 'Éxito'],
  ['--warning', 'Advertencia'],
  ['--error', 'Error'],
  ['--lead-hot', 'Lead caliente'],
  ['--lead-warm', 'Lead tibio'],
  ['--lead-cold', 'Lead frío'],
] as const;

@Component({
  selector: 'app-design-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CdkTableModule,
    DatePipe,
    DecimalPipe,
    Button,
    BrandMark,
    Field,
    Icon,
    Score,
    SortHeader,
    Paginator,
    Tag,
    TagList,
  ],
  host: { class: 'block' },
  template: `
    <header class="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div class="flex items-center gap-3">
          <app-brand-mark />
          <span class="rounded-sm bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning"
            >solo desarrollo</span
          >
        </div>
        <div class="flex gap-1" role="radiogroup" aria-label="Tema">
          @for (option of themes; track option.value) {
            <button
              type="button"
              role="radio"
              appButton
              size="sm"
              [variant]="theme.preference() === option.value ? 'primary' : 'ghost'"
              [attr.aria-checked]="theme.preference() === option.value"
              (click)="theme.set(option.value)"
            >
              {{ option.label }}
            </button>
          }
        </div>
      </div>
    </header>

    <main class="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-8 sm:px-6">
      <section>
        <h1 class="text-[28px] leading-[34px]">Sistema de diseño</h1>
        <p class="mt-1 text-muted">
          Tokens y componentes base del panel. Esta página no existe en producción.
        </p>
      </section>

      <section aria-labelledby="s-colores">
        <h2 id="s-colores" class="text-lg">Colores</h2>
        <ul class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          @for (swatch of swatches; track swatch[0]) {
            <li class="card flex items-center gap-3 p-2.5">
              <span
                class="size-9 shrink-0 rounded-md border border-border"
                [style.background]="'var(' + swatch[0] + ')'"
              ></span>
              <span class="min-w-0">
                <span class="block truncate text-sm font-semibold">{{ swatch[1] }}</span>
                <code class="block truncate text-xs text-muted">{{ swatch[0] }}</code>
              </span>
            </li>
          }
        </ul>
      </section>

      <section aria-labelledby="s-tipo">
        <h2 id="s-tipo" class="text-lg">Tipografía · Plus Jakarta Sans</h2>
        <div class="card mt-3 flex flex-col gap-2 p-5">
          <p class="text-[28px] leading-[34px] font-bold">Título de página 28/34</p>
          <p class="text-[22px] leading-7 font-bold">Título de sección 22/28</p>
          <p class="text-lg font-semibold">Subtítulo 18/26</p>
          <p>Cuerpo 16/24: la IA califica a cada interesado y lo deriva con un resumen.</p>
          <p class="text-sm text-muted">Texto chico 14/20 para tablas y ayudas.</p>
          <p class="text-xs text-subtle">Detalle 12/16</p>
          <p class="tabular text-2xl font-bold">0123456789 · $ 1.234.567,89</p>
        </div>
      </section>

      <section aria-labelledby="s-botones">
        <h2 id="s-botones" class="text-lg">Botones</h2>
        <div class="card mt-3 flex flex-wrap items-center gap-3 p-5">
          <button appButton type="button">Primario</button>
          <button appButton variant="secondary" type="button">Secundario</button>
          <button appButton variant="ghost" type="button">Fantasma</button>
          <button appButton variant="danger" type="button">Peligro</button>
          <button appButton type="button" disabled>Deshabilitado</button>
          <button appButton size="sm" type="button">Chico</button>
          <button appButton variant="secondary" size="sm" type="button">
            <app-icon [icon]="searchIcon" [size]="16" /> Con ícono
          </button>
        </div>
      </section>

      <section aria-labelledby="s-inputs">
        <h2 id="s-inputs" class="text-lg">Campos</h2>
        <div class="card mt-3 grid gap-5 p-5 sm:grid-cols-2">
          <app-field label="Nombre de la empresa" hint="Así lo ven tus vendedores." #f1="appField">
            <input
              class="input"
              [id]="f1.controlId"
              [attr.aria-describedby]="f1.describedBy()"
              placeholder="Ej.: Cerámicos del Sur"
            />
          </app-field>
          <app-field label="Email de contacto" error="Revisá el formato del email." #f2="appField">
            <input
              class="input"
              type="email"
              aria-invalid="true"
              value="ventas@"
              [id]="f2.controlId"
              [attr.aria-describedby]="f2.describedBy()"
            />
          </app-field>
          <app-field label="Rubro" #f3="appField">
            <select class="input" [id]="f3.controlId">
              <option>Cerámicos y revestimientos</option>
              <option>Inmobiliaria</option>
            </select>
          </app-field>
          <app-field label="Deshabilitado" #f4="appField">
            <input
              class="input disabled:bg-surface-2 disabled:text-muted"
              [id]="f4.controlId"
              value="No editable"
              disabled
            />
          </app-field>
        </div>
      </section>

      <section aria-labelledby="s-tarjetas">
        <h2 id="s-tarjetas" class="text-lg">Tarjetas y estados</h2>
        <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div class="card p-5">
            <p class="text-sm text-muted">Leads de hoy</p>
            <p class="tabular mt-1 text-3xl font-bold">{{ 128 | number }}</p>
            <p class="mt-1 text-sm text-success">+12 % que ayer</p>
          </div>
          @for (state of states; track state.label) {
            <div class="card flex items-start gap-3 p-5">
              <span
                class="flex size-9 shrink-0 items-center justify-center rounded-md"
                [class]="state.soft + ' ' + state.text"
              >
                <app-icon [icon]="state.icon" [size]="18" />
              </span>
              <div>
                <p class="font-semibold" [class]="state.text">{{ state.label }}</p>
                <p class="text-sm text-muted">{{ state.description }}</p>
              </div>
            </div>
          }
        </div>
      </section>

      <section aria-labelledby="s-etiquetas">
        <h2 id="s-etiquetas" class="text-lg">Etiquetas</h2>
        <div class="card mt-3 flex flex-col gap-3 p-5">
          <div class="flex flex-wrap gap-1.5">
            <app-tag label="Porcelanato" tone="primary" />
            <app-tag label="Obra nueva" />
            <app-tag label="Pide visita" tone="hot" />
            <app-tag label="Compara precios" tone="warm" />
            <app-tag label="Solo consulta" tone="cold" />
            <app-tag label="Compró" tone="success" />
          </div>
          <app-tag-list [tags]="demoTags" [max]="2" />
        </div>
      </section>

      <section aria-labelledby="s-puntaje">
        <h2 id="s-puntaje" class="text-lg">Indicador de puntaje</h2>
        <p class="mt-1 text-sm text-muted">
          El nivel lo decide el backend con los umbrales de cada empresa. Número, ícono, texto y color siempre
          dicen lo mismo.
        </p>
        <div class="mt-3 grid gap-3 lg:grid-cols-3">
          <div class="card flex flex-col gap-3 p-5">
            <p class="text-sm font-semibold text-muted">Fila (escritorio)</p>
            <app-score [score]="92" level="hot" />
            <app-score [score]="64" level="warm" />
            <app-score [score]="23" level="cold" />
            <app-score [score]="null" [level]="null" />
          </div>
          <div class="card flex flex-col gap-3 p-5">
            <p class="text-sm font-semibold text-muted">Compacto (celular)</p>
            <div class="flex flex-wrap gap-2">
              <app-score [score]="92" level="hot" variant="compact" />
              <app-score [score]="64" level="warm" variant="compact" />
              <app-score [score]="23" level="cold" variant="compact" />
              <app-score [score]="null" [level]="null" variant="compact" />
            </div>
          </div>
          <div class="card flex flex-col gap-5 p-5">
            <p class="text-sm font-semibold text-muted">Detalle</p>
            <app-score [score]="78" level="hot" variant="full" />
            <app-score [score]="41" level="cold" variant="full" />
          </div>
        </div>
      </section>

      <section aria-labelledby="s-tabla">
        <h2 id="s-tabla" class="text-lg">Tabla de leads (vista previa de la 014)</h2>
        <p class="mt-1 text-sm text-muted">
          En escritorio es una tabla ordenable; en el celular, una lista de tarjetas.
        </p>

        <div class="card mt-3 overflow-hidden">
          @if (isDesktop()) {
            <table cdk-table [dataSource]="sortedLeads()" class="w-full text-left text-sm">
              <ng-container cdkColumnDef="name">
                <th
                  cdk-header-cell
                  *cdkHeaderCellDef
                  class="px-4 py-2.5"
                  [attr.aria-sort]="ariaSort(sort(), 'name')"
                >
                  <app-sort-header
                    column="name"
                    label="Lead"
                    [sort]="sort()"
                    (sortChange)="sort.set($event)"
                  />
                </th>
                <td cdk-cell *cdkCellDef="let lead" class="max-w-64 truncate px-4 font-semibold text-text">
                  {{ lead.name }}
                </td>
              </ng-container>
              <ng-container cdkColumnDef="score">
                <th
                  cdk-header-cell
                  *cdkHeaderCellDef
                  class="px-4 py-2.5"
                  [attr.aria-sort]="ariaSort(sort(), 'score')"
                >
                  <app-sort-header
                    column="score"
                    label="Puntaje"
                    [sort]="sort()"
                    (sortChange)="sort.set($event)"
                  />
                </th>
                <td cdk-cell *cdkCellDef="let lead" class="px-4">
                  <app-score [score]="lead.score" [level]="lead.level" />
                </td>
              </ng-container>
              <ng-container cdkColumnDef="tags">
                <th cdk-header-cell *cdkHeaderCellDef class="px-4 py-2.5 font-semibold text-muted">
                  Etiquetas
                </th>
                <td cdk-cell *cdkCellDef="let lead" class="px-4"><app-tag-list [tags]="lead.tags" /></td>
              </ng-container>
              <ng-container cdkColumnDef="last">
                <th
                  cdk-header-cell
                  *cdkHeaderCellDef
                  class="px-4 py-2.5"
                  [attr.aria-sort]="ariaSort(sort(), 'last')"
                >
                  <app-sort-header
                    column="last"
                    label="Último mensaje"
                    [sort]="sort()"
                    (sortChange)="sort.set($event)"
                  />
                </th>
                <td cdk-cell *cdkCellDef="let lead" class="tabular px-4 whitespace-nowrap text-muted">
                  {{ lead.lastMessageAt | date: 'd MMM, HH:mm' }}
                </td>
              </ng-container>
              <tr cdk-header-row *cdkHeaderRowDef="columns" class="border-b border-border bg-surface-2"></tr>
              <tr
                cdk-row
                *cdkRowDef="let row; columns: columns"
                class="h-[var(--row-height)] border-b border-border last:border-0 hover:bg-surface-2"
              ></tr>
            </table>
          } @else {
            <ul class="divide-y divide-border" aria-label="Leads">
              @for (lead of sortedLeads(); track lead.id) {
                <li class="flex items-start gap-3 px-4 py-3">
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-semibold">{{ lead.name }}</p>
                    <p class="tabular mt-0.5 text-sm text-muted">
                      {{ lead.lastMessageAt | date: 'd MMM, HH:mm' }}
                    </p>
                    @if (lead.tags.length) {
                      <app-tag-list class="mt-2" [tags]="lead.tags" [max]="2" />
                    }
                  </div>
                  <app-score [score]="lead.score" [level]="lead.level" variant="compact" />
                </li>
              }
            </ul>
          }
          <app-paginator
            class="border-t border-border px-4 py-2.5"
            [page]="page()"
            [pageSize]="5"
            [total]="47"
            (pageChange)="page.set($event)"
          />
        </div>
      </section>
    </main>
  `,
})
export class DesignPage {
  protected readonly theme = inject(ThemeService);
  protected readonly themes: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'Sistema' },
    { value: 'light', label: 'Claro' },
    { value: 'dark', label: 'Oscuro' },
  ];
  protected readonly swatches = SWATCHES;
  protected readonly demoTags = DEMO_LEADS[0]!.tags;
  protected readonly columns = ['name', 'score', 'tags', 'last'];
  protected readonly searchIcon = Search;
  protected readonly ariaSort = ariaSort;
  protected readonly states = [
    {
      label: 'Éxito',
      description: 'Canal conectado.',
      icon: CircleCheck,
      text: 'text-success',
      soft: 'bg-success-soft',
    },
    {
      label: 'Advertencia',
      description: 'Quedan pocos créditos.',
      icon: TriangleAlert,
      text: 'text-warning',
      soft: 'bg-warning-soft',
    },
    {
      label: 'Error',
      description: 'No se pudo enviar.',
      icon: CircleAlert,
      text: 'text-error',
      soft: 'bg-error-soft',
    },
  ];

  protected readonly sort = signal<SortState | null>({ column: 'score', direction: 'desc' });
  protected readonly page = signal(0);

  protected readonly isDesktop = toSignal(
    inject(BreakpointObserver)
      .observe('(min-width: 768px)')
      .pipe(map((state) => state.matches)),
    { initialValue: true },
  );

  protected readonly sortedLeads = computed(() => {
    const sort = this.sort();
    if (!sort) return DEMO_LEADS;
    const factor = sort.direction === 'asc' ? 1 : -1;
    const key = (lead: DemoLead): number | string =>
      sort.column === 'name'
        ? lead.name
        : sort.column === 'last'
          ? lead.lastMessageAt.getTime()
          : (lead.score ?? -1);
    return [...DEMO_LEADS].sort((a, b) => (key(a) > key(b) ? factor : key(a) < key(b) ? -factor : 0));
  });
}
