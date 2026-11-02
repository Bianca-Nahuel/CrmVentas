import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core';
import { FormField, form, submit, validateStandardSchema, type FieldTree } from '@angular/forms/signals';
import {
  EXTRACTOR_FIELDS,
  EXTRACTOR_PARSERS,
  catalogConfigSchema,
  useBusinessMessages,
  wwwVariant,
  type CatalogConfig,
  type ExtractorField,
  type ExtractorRule,
} from '@ventas/shared/ai';
import { CircleAlert, FlaskConical, Plus, Save } from 'lucide';
import { firstValueFrom } from 'rxjs';
import { AgentConfigApi } from '../../api/agent-config-api';
import { CatalogApi } from '../../api/catalog-api';
import type { ExtractorTestResult } from '../../api/generated';
import { Icon } from '../../ui/icon';
import { NotifyService } from '../../ui/toast';
import { fieldAt, type ServerIssue } from '../agent/agent-draft';
import { NumberInput, RowActions, TextInput, TextList, fieldError } from '../agent/form-ui';
import { readErrorLabel } from './catalog-format';

const FIELD_LABELS: Record<string, string> = {
  list_price: 'Precio de lista',
  promo_price: 'Precio promocional',
  promo_condition: 'Condición de la promo',
  price_no_taxes: 'Precio sin impuestos',
  currency: 'Moneda',
  price_unit: 'Unidad del precio',
  units_per_package: 'm² por caja',
  pieces_per_package: 'Piezas por caja',
  availability: 'Disponibilidad',
  description: 'Descripción',
};

const PARSER_LABELS: Record<(typeof EXTRACTOR_PARSERS)[number], string> = {
  price_ar: 'Precio ($ 12.450,00)',
  number_ar: 'Número (2,02)',
  integer: 'Número entero',
  text: 'Texto',
};

const SOURCE_LABELS: Record<string, string> = {
  jsonld: 'datos estructurados de la página',
  microdata: 'microdatos de la página',
  meta: 'etiquetas de la página',
  extractor: 'tu regla',
};

function starterCatalog(): CatalogConfig {
  return catalogConfigSchema.parse({
    enabled: false,
    allowed_domains: ['www.ejemplo.com.ar'],
    price_policy: { quote: 'list' },
  });
}

/**
 * Configuración del catálogo (tarea 027): dominios, qué precio citar, antigüedades, sinónimos, atributos y el
 * extractor de la web, con "Probar" contra una URL antes de guardar. Se guarda en la config del agente
 * (tenant_configs.config.catalog) con el mismo PUT /api/agent-config, que valida todo de nuevo.
 */
@Component({
  selector: 'app-catalog-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, Icon, NumberInput, RowActions, TextInput, TextList],
  template: `
    @if (status() === 'loading') {
      <p class="text-muted">Cargando…</p>
    } @else if (status() === 'failed') {
      <div class="card flex flex-col items-start gap-3 p-5">
        <p class="font-semibold text-text">No pudimos cargar la configuración.</p>
        <button type="button" class="btn btn-secondary btn-sm" (click)="load()">Reintentar</button>
      </div>
    } @else {
      @if (version() === 0) {
        <p class="mb-4 flex items-start gap-2 rounded-md bg-warning-soft p-3 text-sm text-text">
          <app-icon [icon]="alertIcon" [size]="16" class="mt-0.5 shrink-0 text-warning" />
          Primero guardá la configuración del agente (en Configuración del agente): el catálogo se guarda
          junto con ella.
        </p>
      }
      <div class="flex flex-col gap-5">
        <div class="card flex flex-col gap-4 p-5">
          <h2 class="text-lg font-semibold text-text">Catálogo</h2>
          <label class="flex items-start gap-3">
            <input type="checkbox" class="mt-1 size-5" [formField]="catalogForm.enabled" />
            <span>
              <span class="text-text">El asistente consulta el catálogo</span>
              <span class="block text-sm text-subtle"
                >Busca productos, cita precios y links con los datos de acá, nunca inventados.</span
              >
            </span>
          </label>
          <app-text-list
            [items]="catalogForm.allowed_domains"
            label="Dominios permitidos"
            hint="Solo se leen páginas de estos sitios (sin https:// ni barras). Hasta 5."
            placeholder="www.tuempresa.com.ar"
            [max]="5"
          />
          @for (warning of wwwWarnings(); track warning) {
            <p class="flex items-start gap-2 rounded-md bg-warning-soft p-2.5 text-sm text-text">
              <app-icon [icon]="alertIcon" [size]="16" class="mt-0.5 shrink-0 text-warning" /> {{ warning }}
            </p>
          }
        </div>

        <div class="card flex flex-col gap-4 p-5">
          <h2 class="text-lg font-semibold text-text">Precios y disponibilidad</h2>
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-semibold text-text">Qué precio puede citar</span>
              <select class="input" [formField]="catalogForm.price_policy.quote">
                <option value="none">Ninguno (deriva)</option>
                <option value="list">El de lista</option>
                <option value="promo">El promocional</option>
                <option value="both">Los dos</option>
              </select>
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-semibold text-text">De dónde sale el precio</span>
              <select class="input" [formField]="catalogForm.price_source">
                <option value="web">De la web</option>
                <option value="excel">Del Excel</option>
                <option value="latest">El más reciente</option>
              </select>
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-semibold text-text">Disponibilidad</span>
              <select class="input" [formField]="catalogForm.availability_source">
                <option value="none">Nunca la informa (deriva)</option>
                <option value="web">La de la web</option>
                <option value="excel">La del Excel</option>
              </select>
            </label>
            <label class="flex items-center gap-3 sm:pt-7">
              <input type="checkbox" class="size-5" [formField]="catalogForm.price_policy.show_no_taxes" />
              <span class="text-sm text-text">Sumar el precio sin impuestos cuando está</span>
            </label>
          </div>
          <app-text-input
            [field]="catalogForm.price_policy.note"
            label="Nota después del precio"
            [max]="120"
            placeholder="Precio sujeto a cambios."
          />
          <div class="grid gap-4 sm:grid-cols-3">
            <app-number-input
              [field]="catalogForm.max_price_age_minutes"
              label="Antigüedad máxima de la web (minutos)"
            />
            <app-number-input
              [field]="catalogForm.excel_max_age_days"
              label="Antigüedad máxima del Excel (días)"
            />
            <app-number-input
              [field]="catalogForm.max_price_change_pct"
              label="Salto máximo de precio (%)"
              hint="Más que esto, el precio no se usa hasta confirmarlo."
            />
          </div>
        </div>

        <div class="card flex flex-col gap-4 p-5">
          <h2 class="text-lg font-semibold text-text">Búsqueda</h2>
          @for (synonym of catalogForm.synonyms; track $index; let i = $index) {
            <div class="flex flex-col gap-3 rounded-md border border-border p-4">
              <div class="flex items-center justify-between">
                <p class="font-semibold text-text">Sinónimo {{ i + 1 }}</p>
                <app-row-actions
                  [list]="catalogForm.synonyms"
                  [index]="i"
                  [count]="catalogForm.synonyms.length"
                  [name]="'sinónimo ' + (i + 1)"
                />
              </div>
              <app-text-input
                [field]="synonym.term"
                label="Cuando el cliente dice"
                [max]="40"
                placeholder="piso"
              />
              <app-text-list
                [items]="synonym.equivalents"
                label="Buscar también"
                [max]="10"
                placeholder="porcelanato"
              />
            </div>
          }
          @if (catalogForm.synonyms.length < 50) {
            <button type="button" class="btn btn-secondary btn-sm self-start" (click)="addSynonym()">
              <app-icon [icon]="addIcon" [size]="16" /> Agregar sinónimo
            </button>
          }
          <app-text-list
            [items]="catalogForm.key_attributes"
            label="Atributos clave"
            hint="Columnas del Excel (como quedaron guardadas, por ejemplo color o formato) que el asistente ve al buscar."
            [max]="8"
          />
        </div>

        <div class="card flex flex-col gap-4 p-5" data-testid="extractor">
          <div>
            <h2 class="text-lg font-semibold text-text">Lectura de la web (extractor)</h2>
            <p class="text-sm text-subtle">
              Muchas páginas ya traen el precio en datos estructurados. Si no, o si lo traen mal, agregá una
              regla por campo con el selector del elemento de la página.
            </p>
          </div>
          @for (field of extractorFields; track field) {
            <div class="flex flex-col gap-3 rounded-md border border-border p-4">
              <label class="flex items-center gap-3">
                <input
                  type="checkbox"
                  class="size-5"
                  [checked]="!!rule(field)"
                  (change)="toggleRule(field, $any($event.target).checked)"
                />
                <span class="font-semibold text-text">{{ fieldLabels[field] }}</span>
              </label>
              @if (rule(field); as current) {
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <label class="flex flex-col gap-1.5 lg:col-span-2">
                    <span class="text-sm font-semibold text-text">Selector</span>
                    <input
                      class="input font-mono text-sm"
                      [value]="current.selector"
                      (input)="patchRule(field, { selector: $any($event.target).value })"
                      placeholder=".precio-lista"
                    />
                  </label>
                  <label class="flex flex-col gap-1.5">
                    <span class="text-sm font-semibold text-text">Atributo (opcional)</span>
                    <input
                      class="input font-mono text-sm"
                      [value]="current.attribute ?? ''"
                      (input)="patchRule(field, { attribute: $any($event.target).value || undefined })"
                      placeholder="content"
                    />
                  </label>
                  <label class="flex flex-col gap-1.5">
                    <span class="text-sm font-semibold text-text">Posición</span>
                    <input
                      class="input w-24"
                      type="number"
                      inputmode="numeric"
                      [value]="current.index"
                      (input)="patchRule(field, { index: +$any($event.target).value || 0 })"
                    />
                  </label>
                  <label class="flex flex-col gap-1.5">
                    <span class="text-sm font-semibold text-text">Expresión regular (opcional)</span>
                    <input
                      class="input font-mono text-sm"
                      [value]="current.regex ?? ''"
                      (input)="patchRule(field, { regex: $any($event.target).value || undefined })"
                    />
                  </label>
                  <label class="flex flex-col gap-1.5">
                    <span class="text-sm font-semibold text-text">Tipo de dato</span>
                    <select
                      class="input"
                      [value]="current.parse ?? ''"
                      (change)="patchRule(field, { parse: $any($event.target).value || undefined })"
                    >
                      <option value="">Automático</option>
                      @for (parser of parsers; track parser) {
                        <option [value]="parser">{{ parserLabels[parser] }}</option>
                      }
                    </select>
                  </label>
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      class="size-4"
                      [checked]="current.prefer"
                      (change)="patchRule(field, { prefer: $any($event.target).checked })"
                    />
                    Gana sobre los datos de la página
                  </label>
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      class="size-4"
                      [checked]="current.exclusive"
                      (change)="patchRule(field, { exclusive: $any($event.target).checked })"
                    />
                    Usar solo esta regla
                  </label>
                </div>
                @for (message of ruleIssues(field); track $index) {
                  <p class="text-sm font-medium text-error">{{ message }}</p>
                }
              }
            </div>
          }

          <div class="flex flex-col gap-2 rounded-md bg-surface-2 p-4">
            <label class="text-sm font-semibold text-text" for="extractor-url"
              >Probar con la página de un producto</label
            >
            <div class="flex flex-col gap-2 sm:flex-row">
              <input
                id="extractor-url"
                class="input flex-1"
                type="url"
                placeholder="https://www.tuempresa.com.ar/producto/…"
                [value]="testUrl()"
                (input)="testUrl.set($any($event.target).value)"
                data-testid="extractor-url"
              />
              <button
                type="button"
                class="btn btn-primary"
                [disabled]="testing() || !testUrl().trim()"
                (click)="test()"
                data-testid="extractor-test"
              >
                <app-icon [icon]="testIcon" [size]="18" /> {{ testing() ? 'Leyendo…' : 'Probar' }}
              </button>
            </div>
            <p class="text-xs text-subtle">
              Prueba lo que estás editando, sin guardarlo. Como mucho 10 pruebas por minuto.
            </p>
            @if (testError(); as message) {
              <p class="text-sm font-medium text-error" role="alert">{{ message }}</p>
            }
            @if (result(); as r) {
              @if (r.ok) {
                <div class="flex flex-col gap-1 text-sm" data-testid="extractor-result">
                  @if (r.title) {
                    <p class="text-muted">Página: {{ r.title }}</p>
                  }
                  <ul class="divide-y divide-border rounded-md border border-border bg-surface">
                    @for (item of r.fields; track item.field) {
                      <li class="flex flex-col gap-0.5 p-2 sm:flex-row sm:gap-3">
                        <span class="w-44 shrink-0 font-medium text-text">{{ fieldLabels[item.field] }}</span>
                        <span class="text-text">{{ item.value ?? '—' }}</span>
                        @if (item.source) {
                          <span class="text-xs text-subtle sm:ml-auto"
                            >de {{ sourceLabels[item.source]
                            }}{{ item.matched ? ' (texto: "' + item.matched + '")' : '' }}</span
                          >
                        }
                      </li>
                    }
                  </ul>
                  @for (issue of r.ruleIssues; track $index) {
                    <p class="text-warning">Regla sin resultado: {{ issue }}</p>
                  }
                  <p [class]="r.sanity.ok ? 'text-success' : 'text-error'">
                    {{
                      r.sanity.ok
                        ? 'Los precios pasan los controles.'
                        : 'Los precios no pasan los controles: ' + readError(r.sanity.errorCode)
                    }}
                  </p>
                  @if (r.noAvailability) {
                    <p class="text-warning">
                      La página no informa disponibilidad: el asistente va a derivar cuando se la pregunten.
                    </p>
                  }
                </div>
              } @else {
                <p class="text-sm font-medium text-error" role="alert">{{ readError(r.errorCode) }}</p>
              }
            }
          </div>
        </div>
      </div>

      <div
        class="sticky bottom-0 mt-5 flex flex-col gap-2 border-t border-border bg-bg py-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <p class="text-sm" [class]="dirty() ? 'font-semibold text-text' : 'text-muted'">
          {{ dirty() ? 'Hay cambios sin guardar' : 'Sin cambios' }}
        </p>
        @if (saveError(); as message) {
          <p class="text-sm font-medium text-error" role="alert">{{ message }}</p>
        }
        <button
          type="button"
          class="btn btn-primary"
          [disabled]="!dirty() || saving() || version() === 0"
          (click)="save()"
          data-testid="save-catalog"
        >
          <app-icon [icon]="saveIcon" [size]="18" /> {{ saving() ? 'Guardando…' : 'Guardar' }}
        </button>
      </div>
    }
  `,
})
export class CatalogSettings implements OnInit {
  private readonly configApi = inject(AgentConfigApi);
  private readonly catalogApi = inject(CatalogApi);
  private readonly notify = inject(NotifyService);

  protected readonly extractorFields = EXTRACTOR_FIELDS;
  protected readonly parsers = EXTRACTOR_PARSERS;
  protected readonly fieldLabels = FIELD_LABELS;
  protected readonly parserLabels = PARSER_LABELS;
  protected readonly sourceLabels = SOURCE_LABELS;
  protected readonly readError = readErrorLabel;
  protected readonly alertIcon = CircleAlert;
  protected readonly addIcon = Plus;
  protected readonly testIcon = FlaskConical;
  protected readonly saveIcon = Save;

  protected readonly status = signal<'loading' | 'ready' | 'failed'>('loading');
  protected readonly version = signal(0);
  private rawConfig: Record<string, unknown> = {};
  private readonly original = signal('');
  private readonly model = signal<CatalogConfig>(starterCatalog());
  protected readonly catalogForm = form(this.model, (path) => {
    validateStandardSchema(path, catalogConfigSchema as never);
  });
  protected readonly dirty = computed(() => JSON.stringify(this.model()) !== this.original());
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);

  protected readonly testUrl = signal('');
  protected readonly testing = signal(false);
  protected readonly testError = signal<string | null>(null);
  protected readonly result = signal<ExtractorTestResult | null>(null);

  /** El aviso de la variante con y sin www (una redirección a la otra se rechaza). */
  protected readonly wwwWarnings = computed(() => {
    const domains = this.model()
      .allowed_domains.map((domain) => domain.trim().toLowerCase())
      .filter(Boolean);
    return domains
      .filter((domain) => !domains.includes(wwwVariant(domain)))
      .map(
        (domain) =>
          `Está ${domain} pero no ${wwwVariant(domain)}: si un link o la web redirigen a esa variante, no se va a poder leer. Agregala si el sitio la usa.`,
      );
  });

  private readonly issues = computed(() => {
    const parsed = catalogConfigSchema.safeParse(this.model());
    return parsed.success ? [] : parsed.error.issues;
  });

  constructor() {
    useBusinessMessages();
  }

  ngOnInit(): void {
    void this.load();
  }

  async load() {
    this.status.set('loading');
    try {
      const current = await firstValueFrom(this.configApi.current());
      this.version.set(current.version ?? 0);
      this.rawConfig = current.config ?? {};
      const parsed = catalogConfigSchema.safeParse(this.rawConfig['catalog']);
      const catalog = parsed.success ? parsed.data : starterCatalog();
      this.model.set(structuredClone(catalog));
      this.original.set(JSON.stringify(catalog));
      this.catalogForm().reset();
      this.status.set('ready');
    } catch {
      this.status.set('failed');
    }
  }

  protected rule(field: ExtractorField): ExtractorRule | undefined {
    return this.model().extractor?.fields[field];
  }

  protected ruleIssues(field: ExtractorField): string[] {
    return this.issues()
      .filter((issue) => issue.path[0] === 'extractor' && issue.path[2] === field)
      .map((issue) => `${String(issue.path.at(-1) ?? '')}: ${issue.message}`);
  }

  private setRule(field: ExtractorField, rule: ExtractorRule | undefined) {
    this.model.update((catalog) => {
      const extractor = catalog.extractor ?? {
        fields: {},
        availability_map: { in_stock: [], out_of_stock: [] },
      };
      const fields = { ...extractor.fields };
      if (rule) fields[field] = rule;
      else delete fields[field];
      return { ...catalog, extractor: { ...extractor, fields } };
    });
  }

  protected toggleRule(field: ExtractorField, on: boolean) {
    this.setRule(field, on ? { selector: '', index: 0, prefer: false, exclusive: false } : undefined);
  }

  protected patchRule(field: ExtractorField, patch: Partial<ExtractorRule>) {
    const current = this.rule(field);
    if (!current) return;
    const next = { ...current, ...patch } as Record<string, unknown>;
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    this.setRule(field, next as ExtractorRule);
  }

  protected addSynonym() {
    this.catalogForm.synonyms().value.update((list) => [...list, { term: '', equivalents: [''] }]);
  }

  protected async test() {
    this.testError.set(null);
    this.result.set(null);
    this.testing.set(true);
    try {
      this.result.set(
        await firstValueFrom(this.catalogApi.testExtractor(this.testUrl().trim(), this.model())),
      );
    } catch (error) {
      const status = error instanceof HttpErrorResponse ? error.status : 0;
      this.testError.set(
        status === 429
          ? 'Hiciste muchas pruebas seguidas: esperá un minuto.'
          : status === 400
            ? 'Hay datos del catálogo para revisar antes de probar (por ejemplo, un selector inválido).'
            : 'No pudimos probar la página.',
      );
    } finally {
      this.testing.set(false);
    }
  }

  protected async save() {
    this.saveError.set(null);
    await submit(this.catalogForm, {
      action: async () => {
        this.saving.set(true);
        try {
          const saved = await firstValueFrom(
            this.configApi.save({
              config: { ...this.rawConfig, catalog: this.model() },
              expectedVersion: this.version(),
            }),
          );
          this.notify.success(`Guardaste la versión ${saved.version} de la configuración.`);
          await this.load();
          return undefined;
        } catch (error) {
          const payload =
            error instanceof HttpErrorResponse
              ? ((error.error ?? {}) as { code?: string; issues?: ServerIssue[] })
              : {};
          if (payload.code === 'VERSION_CONFLICT') {
            this.saveError.set(
              'Otra persona guardó la configuración en el medio. Recargá la página para ver la última.',
            );
            return undefined;
          }
          if (payload.code === 'INVALID_CONFIG') {
            const inCatalog = (payload.issues ?? []).filter((issue) => issue.path[0] === 'catalog');
            this.saveError.set(
              inCatalog.length
                ? 'Hay campos para revisar.'
                : 'La configuración del agente tiene otros campos para revisar: corregilos en Configuración del agente.',
            );
            return inCatalog.map((issue) => ({
              kind: 'server',
              message: issue.message,
              fieldTree:
                fieldAt(this.catalogForm as FieldTree<unknown>, issue.path.slice(1)) ?? this.catalogForm,
            }));
          }
          this.saveError.set('No pudimos guardar.');
          return undefined;
        } finally {
          this.saving.set(false);
        }
      },
      onInvalid: () => this.saveError.set('Hay campos para revisar.'),
    });
  }

  protected error = fieldError;
}
