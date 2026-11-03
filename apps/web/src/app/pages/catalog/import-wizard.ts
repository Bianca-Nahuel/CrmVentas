import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormField, form, required, submit } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { CircleAlert, FileSpreadsheet, TriangleAlert, Upload } from 'lucide';
import { firstValueFrom } from 'rxjs';
import { CatalogApi } from '../../api/catalog-api';
import type { ImportApplyResult, ImportPreview, ImportRowList } from '../../api/generated';
import { ConfirmService } from '../../ui/confirm-dialog';
import { Icon } from '../../ui/icon';
import { Paginator } from '../../ui/table';
import { Spinner } from '../../ui/spinner';

const MAX_BYTES = 5 * 1024 * 1024;

/** Campos a los que se puede mapear una columna (los mismos del importador, normalize-rows.ts). */
const FIELDS = [
  { key: 'sku', label: 'Código (SKU)', required: true },
  { key: 'name', label: 'Nombre', required: true },
  { key: 'url', label: 'Link de la página', required: false },
  { key: 'category', label: 'Categoría', required: false },
  { key: 'unit', label: 'Unidad de venta', required: false },
  { key: 'units_per_package', label: 'm² (o unidades) por caja', required: false },
  { key: 'pieces_per_package', label: 'Piezas por caja', required: false },
  { key: 'price', label: 'Precio', required: false },
  { key: 'stock', label: 'Stock', required: false },
] as const;
type FieldKey = (typeof FIELDS)[number]['key'];
type Mapping = Record<FieldKey, string>;

const FILTERS = [
  { value: 'all', label: 'Todas las filas' },
  { value: 'new', label: 'Nuevos' },
  { value: 'changed', label: 'Cambiados' },
  { value: 'unchanged', label: 'Sin cambios' },
  { value: 'invalid', label: 'Inválidas' },
  { value: 'jump', label: 'Saltos de precio' },
] as const;
type RowFilter = (typeof FILTERS)[number]['value'];

const UPLOAD_ERRORS: Record<number, string> = {
  413: 'El archivo pesa más de 5 MB.',
};

const FIELD_NAMES: Record<string, string> = {
  name: 'Nombre',
  category: 'Categoría',
  unit: 'Unidad',
  units_per_package: 'Por caja',
  pieces_per_package: 'Piezas',
  url: 'Link',
  price: 'Precio',
  active: 'Activo',
};

function emptyMapping(): Mapping {
  return {
    sku: '',
    name: '',
    url: '',
    category: '',
    unit: '',
    units_per_package: '',
    pieces_per_package: '',
    price: '',
    stock: '',
  };
}

/**
 * Importar (tarea 027): subir el .xlsx → mapear columnas → revisar y aplicar. Todo lo valida la API (el
 * tipo por contenido, el tamaño antes de leerlo, cada fila); el navegador solo adelanta los avisos.
 */
@Component({
  selector: 'app-catalog-import-wizard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, Icon, Paginator, RouterLink, Spinner],
  template: `
    <ol class="mb-5 flex flex-wrap gap-2 text-sm" aria-label="Pasos">
      @for (label of stepLabels; track $index; let i = $index) {
        <li
          class="flex items-center gap-2 rounded-full border px-3 py-1"
          [class]="
            i === stepIndex()
              ? 'border-primary bg-primary-soft text-primary-strong font-semibold'
              : 'border-border text-muted'
          "
          [attr.aria-current]="i === stepIndex() ? 'step' : null"
        >
          {{ i + 1 }}. {{ label }}
        </li>
      }
    </ol>

    @if (step() === 'upload') {
      <div
        class="card flex flex-col items-center gap-3 border-2 border-dashed p-8 text-center"
        [class.border-primary]="dragging()"
        (dragover)="$event.preventDefault(); dragging.set(true)"
        (dragleave)="dragging.set(false)"
        (drop)="onDrop($event)"
        data-testid="drop-zone"
      >
        <app-icon [icon]="fileIcon" [size]="36" class="text-primary" />
        <p class="font-semibold text-text">Arrastrá el Excel acá</p>
        <p class="text-sm text-subtle">Hasta 5 MB y 10.000 filas, solo .xlsx.</p>
        <label class="btn btn-primary cursor-pointer">
          @if (busy()) {
            <app-spinner [size]="18" />
          } @else {
            <app-icon [icon]="uploadIcon" [size]="18" />
          }
          {{ busy() ? 'Subiendo…' : 'Elegir archivo' }}
          <input
            type="file"
            class="sr-only"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            (change)="onPick($event)"
            [disabled]="busy()"
            data-testid="file-input"
          />
        </label>
      </div>
    }

    @if (step() === 'map' && preview(); as current) {
      <div class="card flex flex-col gap-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-text">Mapear columnas</h2>
          <p class="text-sm text-subtle">
            {{ current.fileName }} · hoja "{{ current.sheetName }}" ·
            {{
              current.mappingSource === 'saved'
                ? 'usamos el mapeo de la importación anterior'
                : current.mappingSource === 'proposed'
                  ? 'propusimos un mapeo por los encabezados'
                  : 'elegí las columnas'
            }}
          </p>
        </div>
        @for (field of fields; track field.key) {
          <div class="grid gap-2 sm:grid-cols-[14rem_1fr] sm:items-start">
            <label class="pt-2 text-sm font-semibold text-text" [attr.for]="'map-' + field.key">
              {{ field.label }}{{ field.required ? ' *' : '' }}
            </label>
            <div>
              <select class="input" [id]="'map-' + field.key" [formField]="mappingForm[field.key]">
                <option value="">{{ field.required ? 'Elegí una columna' : '— Sin columna —' }}</option>
                @for (header of headerOptions(); track header) {
                  <option [value]="header">{{ header }}</option>
                }
              </select>
              @if (samples(field.key); as values) {
                <p class="mt-1 truncate text-xs text-subtle">Ej.: {{ values }}</p>
              }
              @if (mappingError(field.key); as message) {
                <p class="mt-1 text-sm font-medium text-error">{{ message }}</p>
              }
            </div>
          </div>
        }
        <p class="rounded-md bg-surface-2 p-3 text-sm text-muted">
          Las demás columnas se guardan como atributos del producto.
        </p>
        @if (error(); as message) {
          <p class="text-sm font-medium text-error" role="alert">{{ message }}</p>
        }
        <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <button type="button" class="btn btn-secondary" (click)="restart()">Subir otro archivo</button>
          <button
            type="button"
            class="btn btn-primary"
            [disabled]="busy()"
            (click)="seeChanges()"
            data-testid="see-changes"
          >
            @if (busy()) {
              <app-spinner [size]="18" />
            }
            {{ busy() ? 'Calculando…' : 'Ver cambios' }}
          </button>
        </div>
      </div>
    }

    @if (step() === 'review' && preview(); as current) {
      @if (current.counts; as counts) {
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="import-counts">
          @for (tile of tiles(); track tile.label) {
            <div class="card p-3" [class.border-warning]="tile.warn">
              <p class="tabular text-2xl font-semibold text-text">{{ tile.value }}</p>
              <p class="text-sm text-muted">{{ tile.label }}</p>
            </div>
          }
        </div>
        @if (counts.priceJumps > 0) {
          <p class="mt-3 flex items-start gap-2 rounded-md bg-warning-soft p-3 text-sm text-text">
            <app-icon [icon]="warnIcon" [size]="16" class="mt-0.5 shrink-0 text-warning" />
            {{ counts.priceJumps }} {{ counts.priceJumps === 1 ? 'precio cambia' : 'precios cambian' }} más
            del 40 %. Revisalos antes de aplicar.
          </p>
        }
        @if (counts.missing > 0) {
          <p class="mt-3 text-sm text-muted">
            {{ counts.missing }} {{ counts.missing === 1 ? 'producto no está' : 'productos no están' }} en el
            archivo y {{ counts.missing === 1 ? 'pasa' : 'pasan' }} a inactivos (no se borran):
            {{ current.missing.join(', ') }}{{ counts.missing > current.missing.length ? '…' : '' }}
          </p>
        }
      }

      <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <select
          class="input sm:w-56"
          aria-label="Filtrar filas"
          [value]="filter()"
          (change)="setFilter($any($event.target).value)"
        >
          @for (option of filters; track option.value) {
            <option [value]="option.value">{{ option.label }}</option>
          }
        </select>
      </div>

      <div class="mt-3 flex flex-col gap-2" data-testid="import-rows">
        @if (rows(); as list) {
          @for (row of list.items; track row.rowNumber) {
            <div
              class="card p-3 text-sm"
              [class.border-error]="row.status === 'invalid'"
              [class.border-warning]="row.priceJump"
            >
              <p class="text-text">
                <span class="tabular text-subtle">Fila {{ row.rowNumber }}</span> ·
                <span class="font-semibold">{{ row.sku ?? 'sin código' }}</span> {{ row.name ?? '' }}
                <span class="ml-1 text-xs text-muted">{{ changeLabel(row.change, row.status) }}</span>
                @if (row.priceJump) {
                  <span class="ml-1 text-xs font-semibold text-warning">salto de precio</span>
                }
              </p>
              @for (message of row.errors; track $index) {
                <p class="mt-1 flex items-start gap-1.5 text-error">
                  <app-icon [icon]="alertIcon" [size]="14" class="mt-0.5 shrink-0" /> {{ message }}
                </p>
              }
              @for (change of row.fields; track change.field) {
                <p class="mt-1 text-muted">
                  {{ fieldName(change.field) }}: {{ change.before ?? '(vacío)' }} →
                  <span class="text-text">{{ change.after ?? '(vacío)' }}</span>
                </p>
              }
            </div>
          } @empty {
            <p class="text-muted">No hay filas con ese filtro.</p>
          }
          <app-paginator
            [page]="rowsPage()"
            [pageSize]="list.pageSize"
            [total]="list.total"
            (pageChange)="loadRows($event)"
          />
        } @else {
          <p class="flex items-center gap-2 text-muted" role="status"><app-spinner /> Cargando…</p>
        }
      </div>

      @if (stale()) {
        <div class="card mt-4 flex flex-col gap-2 border-warning p-4" role="alert">
          <p class="text-sm text-text">
            Mientras revisabas se aplicó otra importación, así que esta vista previa quedó vieja. Rehacela
            para ver los cambios contra el catálogo de ahora (no hace falta volver a subir el archivo).
          </p>
          <button
            type="button"
            class="btn btn-secondary btn-sm self-start"
            [disabled]="busy()"
            (click)="seeChanges()"
          >
            Rehacer vista previa
          </button>
        </div>
      }
      @if (error(); as message) {
        <p class="mt-3 text-sm font-medium text-error" role="alert">{{ message }}</p>
      }
      <div class="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <button type="button" class="btn btn-secondary" (click)="step.set('map')">Volver al mapeo</button>
        <button
          type="button"
          class="btn btn-primary"
          [disabled]="busy() || stale() || !canApply()"
          (click)="apply()"
          data-testid="apply-import"
        >
          @if (busy()) {
            <app-spinner [size]="18" />
          }
          {{ busy() ? 'Aplicando…' : 'Aplicar' }}
        </button>
      </div>
    }

    @if (step() === 'done' && applied(); as result) {
      <div class="card flex flex-col items-start gap-3 p-5" role="status">
        <h2 class="text-lg font-semibold text-text">Listo: el catálogo se actualizó</h2>
        <p class="text-sm text-muted">
          {{ result.upserted }} productos cargados o actualizados, {{ result.deactivated }} pasaron a
          inactivos y {{ result.snapshots }} precios o stocks del Excel quedaron registrados.
        </p>
        <div class="flex flex-wrap gap-2">
          <a class="btn btn-secondary btn-sm" routerLink="/catalogo/productos">Ver productos</a>
          <a class="btn btn-ghost btn-sm" routerLink="/catalogo/historial">Historial</a>
          <button type="button" class="btn btn-ghost btn-sm" (click)="restart()">Importar otro</button>
        </div>
      </div>
    }

    @if (step() === 'upload' && error(); as message) {
      <p class="mt-3 text-sm font-medium text-error" role="alert" data-testid="upload-error">{{ message }}</p>
    }
  `,
})
export class ImportWizard {
  private readonly api = inject(CatalogApi);
  private readonly confirm = inject(ConfirmService);

  protected readonly fields = FIELDS;
  protected readonly filters = FILTERS;
  protected readonly stepLabels = ['Subir', 'Mapear columnas', 'Revisar y aplicar'];
  protected readonly fileIcon = FileSpreadsheet;
  protected readonly uploadIcon = Upload;
  protected readonly warnIcon = TriangleAlert;
  protected readonly alertIcon = CircleAlert;

  protected readonly step = signal<'upload' | 'map' | 'review' | 'done'>('upload');
  protected readonly stepIndex = computed(() => ({ upload: 0, map: 1, review: 2, done: 2 })[this.step()]);
  protected readonly busy = signal(false);
  protected readonly dragging = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly preview = signal<ImportPreview | null>(null);
  protected readonly rows = signal<ImportRowList | null>(null);
  protected readonly rowsPage = signal(0);
  protected readonly filter = signal<RowFilter>('all');
  protected readonly stale = signal(false);
  protected readonly applied = signal<ImportApplyResult | null>(null);

  private readonly mapping = signal<Mapping>(emptyMapping());
  protected readonly mappingForm = form(this.mapping, (path) => {
    required(path.sku, { message: 'Elegí la columna del código.' });
    required(path.name, { message: 'Elegí la columna del nombre.' });
  });

  protected readonly headerOptions = computed(() => [
    ...new Set((this.preview()?.headers ?? []).filter((header) => header.trim() !== '')),
  ]);

  protected readonly tiles = computed(() => {
    const counts = this.preview()?.counts;
    if (!counts) return [];
    return [
      { label: 'Nuevos', value: counts.new, warn: false },
      { label: 'Cambiados', value: counts.changed, warn: false },
      { label: 'Sin cambios', value: counts.unchanged, warn: false },
      { label: 'Ausentes', value: counts.missing, warn: counts.missing > 0 },
      { label: 'Inválidas', value: counts.invalid, warn: counts.invalid > 0 },
      { label: 'Saltos de precio', value: counts.priceJumps, warn: counts.priceJumps > 0 },
    ];
  });

  protected readonly canApply = computed(() => {
    const counts = this.preview()?.counts;
    return !!counts && counts.rows - counts.invalid > 0;
  });

  protected mappingError(key: FieldKey): string | null {
    const state = this.mappingForm[key]();
    return state.touched() ? (state.errors()[0]?.message ?? null) : null;
  }

  protected samples(key: FieldKey): string | null {
    const preview = this.preview();
    const header = this.mapping()[key];
    if (!preview || !header) return null;
    const column = preview.headers.indexOf(header);
    if (column === -1) return null;
    const values = preview.sample.map((row) => row[column]).filter((value) => value);
    return values.slice(0, 3).join(' · ') || null;
  }

  protected changeLabel(change: string | null, status: string): string {
    if (status === 'invalid') return 'inválida';
    return change === 'new' ? 'nuevo' : change === 'changed' ? 'cambia' : 'sin cambios';
  }

  protected fieldName(field: string): string {
    if (field.startsWith('attributes.')) return field.slice('attributes.'.length);
    return FIELD_NAMES[field] ?? field;
  }

  protected onPick(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.upload(file);
  }

  protected onDrop(event: DragEvent) {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.upload(file);
  }

  private async upload(file: File) {
    this.error.set(null);
    // Avisos adelantados; quien decide es la API.
    if (!/\.xlsx$/i.test(file.name)) {
      this.error.set(
        'El archivo tiene que ser un .xlsx. Abrilo en Excel o Google Sheets y guardalo como .xlsx.',
      );
      return;
    }
    if (file.size > MAX_BYTES) {
      this.error.set(UPLOAD_ERRORS[413]!);
      return;
    }
    this.busy.set(true);
    try {
      const preview = await firstValueFrom(this.api.upload(file));
      this.preview.set(preview);
      this.mapping.set({ ...emptyMapping(), ...(preview.mapping?.columns ?? {}) } as Mapping);
      this.mappingForm().reset();
      this.step.set('map');
    } catch (error) {
      this.error.set(this.messageOf(error, 'No pudimos subir el archivo.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async seeChanges() {
    const preview = this.preview();
    if (!preview) return;
    this.error.set(null);
    await submit(this.mappingForm, {
      action: async () => {
        this.busy.set(true);
        try {
          const columns = Object.fromEntries(
            Object.entries(this.mapping()).filter(([, header]) => header !== ''),
          );
          const next = await firstValueFrom(
            this.api.rePreview(preview.importId, {
              sheet: preview.sheetName,
              ...(preview.headerRow ? { header_row: preview.headerRow } : {}),
              columns,
            }),
          );
          this.preview.set(next);
          this.stale.set(false);
          this.step.set('review');
          this.filter.set('all');
          await this.loadRows(0);
        } catch (error) {
          this.error.set(this.messageOf(error, 'No pudimos armar la vista previa.'));
        } finally {
          this.busy.set(false);
        }
        return undefined;
      },
    });
  }

  protected setFilter(value: RowFilter) {
    this.filter.set(value);
    void this.loadRows(0);
  }

  async loadRows(page: number) {
    const preview = this.preview();
    if (!preview) return;
    this.rowsPage.set(page);
    const filter = this.filter();
    try {
      this.rows.set(
        await firstValueFrom(
          this.api.rows({
            id: preview.importId,
            page: page + 1,
            ...(filter === 'new' || filter === 'changed' || filter === 'unchanged' ? { change: filter } : {}),
            ...(filter === 'invalid' ? { status: 'invalid' as const } : {}),
            ...(filter === 'jump' ? { priceJump: 'true' as const } : {}),
          }),
        ),
      );
    } catch {
      this.error.set('No pudimos cargar las filas.');
    }
  }

  protected async apply() {
    const preview = this.preview();
    const counts = preview?.counts;
    if (!preview || !counts) return;
    const ok = await firstValueFrom(
      this.confirm.ask({
        title: 'Aplicar la importación',
        message:
          `Se cargan ${counts.new} productos nuevos y se actualizan ${counts.changed}.` +
          (counts.missing ? ` ${counts.missing} pasan a inactivos.` : '') +
          (counts.invalid ? ` Las ${counts.invalid} filas inválidas no se cargan.` : '') +
          ' Después podés volver a la importación anterior desde el Historial.',
        confirmLabel: 'Aplicar',
      }),
    );
    if (!ok) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      this.applied.set(await firstValueFrom(this.api.apply(preview.importId)));
      this.step.set('done');
    } catch (error) {
      const code =
        error instanceof HttpErrorResponse ? (error.error as { code?: string } | null)?.code : null;
      if (code === 'STALE_PREVIEW') this.stale.set(true);
      else this.error.set(this.messageOf(error, 'No pudimos aplicar la importación.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected restart() {
    this.step.set('upload');
    this.preview.set(null);
    this.rows.set(null);
    this.applied.set(null);
    this.error.set(null);
    this.stale.set(false);
  }

  /** El mensaje de la API para el archivo o el mapeo (textos fijos del importador) o uno genérico. */
  private messageOf(error: unknown, fallback: string): string {
    if (!(error instanceof HttpErrorResponse)) return fallback;
    const payload = (error.error ?? {}) as { code?: string; message?: string };
    if (UPLOAD_ERRORS[error.status]) return UPLOAD_ERRORS[error.status]!;
    if (payload.code === 'CATALOG_NOT_CONFIGURED') {
      return 'Primero configurá los dominios permitidos en la pestaña Configuración.';
    }
    if (payload.code === 'FILE_EXPIRED') return 'Pasaron más de 24 horas: volvé a subir el archivo.';
    if (payload.code === 'NOT_PREVIEW') return 'Esta importación ya se aplicó.';
    if (payload.code === 'NO_VALID_ROWS') return 'El archivo no tiene ninguna fila válida.';
    if ((payload.code === 'INVALID_FILE' || payload.code === 'INVALID_MAPPING') && payload.message) {
      return payload.message;
    }
    return fallback;
  }
}
