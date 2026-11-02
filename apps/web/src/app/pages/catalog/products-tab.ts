import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ExternalLink, RefreshCw, Search, X } from 'lucide';
import { firstValueFrom } from 'rxjs';
import { CatalogApi } from '../../api/catalog-api';
import type { ProductDetail, ProductSummary } from '../../api/generated';
import { query } from '../../core/query';
import { Icon } from '../../ui/icon';
import { Paginator } from '../../ui/table';
import { NotifyService } from '../../ui/toast';
import { money, readErrorLabel, shortDateTime, sourceLabel, unitLabel } from './catalog-format';

/** Productos: búsqueda, activos o inactivos, tabla (tarjetas en el celular) y el detalle de cada uno. */
@Component({
  selector: 'app-catalog-products-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Paginator],
  template: `
    <div class="flex flex-col gap-3 sm:flex-row">
      <label class="relative flex-1">
        <span class="sr-only">Buscar por nombre o código</span>
        <app-icon
          [icon]="searchIcon"
          [size]="18"
          class="pointer-events-none absolute top-3 left-3 text-subtle"
        />
        <input
          class="input pl-10"
          type="search"
          placeholder="Buscar por nombre o código"
          [value]="search()"
          (input)="onSearch($any($event.target).value)"
        />
      </label>
      <select
        class="input sm:w-48"
        aria-label="Mostrar"
        [value]="active()"
        (change)="active.set($any($event.target).value); page.set(0)"
      >
        <option value="true">Activos</option>
        <option value="false">Inactivos</option>
        <option value="all">Todos</option>
      </select>
    </div>

    <div class="mt-4 flex flex-col gap-4 xl:flex-row">
      <div class="min-w-0 flex-1">
        @if (products.loadFailed()) {
          <div class="card flex flex-col items-start gap-3 p-5">
            <p class="font-semibold text-text">No pudimos cargar los productos.</p>
            <button type="button" class="btn btn-secondary btn-sm" (click)="products.reload()">
              Reintentar
            </button>
          </div>
        } @else if (!products.hasValue()) {
          <p class="text-muted">Cargando…</p>
        } @else if (products.value().items.length === 0) {
          <div class="card p-5 text-muted">
            No hay productos{{ search() ? ' con esa búsqueda' : '' }}. Se cargan desde la pestaña Importar.
          </div>
        } @else {
          <ul class="flex flex-col gap-2 md:hidden" aria-label="Productos">
            @for (product of products.value().items; track product.sku) {
              <li>
                <button type="button" class="card w-full p-4 text-left" (click)="open(product)">
                  <p class="font-semibold text-text">{{ product.name }}</p>
                  <p class="tabular text-sm text-subtle">
                    {{ product.sku }} · {{ product.category ?? 'Sin categoría' }} · {{ unit(product.unit) }}
                  </p>
                  <p class="mt-1 text-sm text-text">{{ price(product) }}</p>
                </button>
              </li>
            }
          </ul>
          <div class="card hidden overflow-x-auto md:block">
            <table class="w-full text-left text-sm">
              <thead class="text-muted">
                <tr>
                  <th scope="col" class="p-3">SKU</th>
                  <th scope="col" class="p-3">Nombre</th>
                  <th scope="col" class="p-3">Categoría</th>
                  <th scope="col" class="p-3">Unidad</th>
                  <th scope="col" class="p-3">Último precio</th>
                  <th scope="col" class="p-3"><span class="sr-only">Link</span></th>
                </tr>
              </thead>
              <tbody>
                @for (product of products.value().items; track product.sku) {
                  <tr
                    class="cursor-pointer border-t border-border hover:bg-surface-2"
                    (click)="open(product)"
                    [class.bg-primary-soft]="selected() === product.sku"
                    data-testid="product-row"
                  >
                    <td class="tabular p-3 text-muted">
                      <button
                        type="button"
                        class="text-left font-medium text-text underline-offset-2 hover:underline"
                        (click)="open(product); $event.stopPropagation()"
                      >
                        {{ product.sku }}
                      </button>
                    </td>
                    <td class="p-3 text-text">
                      {{ product.name }}
                      @if (!product.active) {
                        <span class="ml-1 text-xs text-warning">inactivo</span>
                      }
                    </td>
                    <td class="p-3 text-muted">{{ product.category ?? '—' }}</td>
                    <td class="p-3 text-muted">{{ unit(product.unit) }}</td>
                    <td class="p-3">
                      <span class="text-text">{{ price(product) }}</span>
                      @if (product.price; as p) {
                        <span class="block text-xs text-subtle"
                          >{{ source(p.source) }}, {{ date(p.readAt) }}</span
                        >
                      }
                    </td>
                    <td class="p-3">
                      @if (product.url) {
                        <a
                          class="text-primary"
                          [href]="product.url"
                          target="_blank"
                          rel="noopener noreferrer"
                          (click)="$event.stopPropagation()"
                          [attr.aria-label]="'Abrir la página de ' + product.name"
                        >
                          <app-icon [icon]="linkIcon" [size]="16" />
                        </a>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <app-paginator
            class="mt-3"
            [page]="page()"
            [pageSize]="products.value().pageSize"
            [total]="products.value().total"
            (pageChange)="page.set($event)"
          />
        }
      </div>

      @if (selected()) {
        <aside
          class="card flex flex-col gap-3 p-5 xl:w-96 xl:shrink-0"
          aria-label="Detalle del producto"
          data-testid="product-detail"
        >
          @if (detail(); as product) {
            <div class="flex items-start justify-between gap-2">
              <div>
                <h2 class="text-lg font-semibold text-text">{{ product.name }}</h2>
                <p class="tabular text-sm text-subtle">{{ product.sku }} · {{ unit(product.unit) }}</p>
              </div>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                (click)="close()"
                aria-label="Cerrar detalle"
              >
                <app-icon [icon]="closeIcon" [size]="16" />
              </button>
            </div>
            <p class="text-text">{{ price(product) }}</p>
            @if (product.url) {
              <a
                class="flex items-center gap-1 break-all text-sm text-primary"
                [href]="product.url"
                target="_blank"
                rel="noopener noreferrer"
              >
                <app-icon [icon]="linkIcon" [size]="14" /> {{ product.url }}
              </a>
            }
            <button
              type="button"
              class="btn btn-secondary btn-sm self-start"
              [disabled]="refreshing() || !product.url"
              (click)="refresh(product.sku)"
              data-testid="refresh-price"
            >
              <app-icon [icon]="refreshIcon" [size]="16" />
              {{ refreshing() ? 'Leyendo la página…' : 'Actualizar precio' }}
            </button>
            @if (product.unitsPerPackage || product.piecesPerPackage) {
              <p class="text-sm text-muted">
                @if (product.unitsPerPackage) {
                  {{ product.unitsPerPackage }} {{ unit(product.unit) }} por caja
                }
                @if (product.piecesPerPackage) {
                  · {{ product.piecesPerPackage }} piezas
                }
              </p>
            }
            @if (product.attributes.length) {
              <h3 class="text-sm font-semibold text-text">Atributos</h3>
              <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                @for (attribute of product.attributes; track attribute.key) {
                  <dt class="text-muted">{{ attribute.key }}</dt>
                  <dd class="text-text">{{ attribute.value }}</dd>
                }
              </dl>
            }
            <h3 class="text-sm font-semibold text-text">Últimas lecturas</h3>
            <ul class="flex flex-col divide-y divide-border text-sm">
              @for (snapshot of product.snapshots; track snapshot.id) {
                <li class="py-1.5">
                  <span class="text-text">{{
                    snapshot.ok ? money(snapshot.listPrice, snapshot.currency) : 'No se pudo usar'
                  }}</span>
                  @if (snapshot.promoPrice) {
                    <span class="text-muted">
                      · promo {{ money(snapshot.promoPrice, snapshot.currency) }}</span
                    >
                  }
                  <span class="block text-xs text-subtle">
                    {{ source(snapshot.source) }}, {{ date(snapshot.readAt) }}
                    @if (!snapshot.ok) {
                      · {{ readError(snapshot.errorCode) }}
                    }
                  </span>
                </li>
              } @empty {
                <li class="py-1.5 text-muted">Todavía no hay lecturas.</li>
              }
            </ul>
          } @else {
            <p class="text-muted">Cargando…</p>
          }
        </aside>
      }
    </div>
  `,
})
export class ProductsTab {
  private readonly api = inject(CatalogApi);
  private readonly notify = inject(NotifyService);
  protected readonly searchIcon = Search;
  protected readonly linkIcon = ExternalLink;
  protected readonly refreshIcon = RefreshCw;
  protected readonly closeIcon = X;
  protected readonly unit = unitLabel;
  protected readonly money = money;
  protected readonly date = shortDateTime;
  protected readonly source = sourceLabel;
  protected readonly readError = readErrorLabel;

  protected readonly search = signal('');
  private readonly debounced = signal('');
  protected readonly active = signal<'true' | 'false' | 'all'>('true');
  protected readonly page = signal(0);
  protected readonly selected = signal<string | null>(null);
  protected readonly detail = signal<ProductDetail | null>(null);
  protected readonly refreshing = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly products = query(
    () => ({ q: this.debounced() || undefined, active: this.active(), page: this.page() + 1 }),
    (params) => this.api.products(params),
  );

  protected onSearch(value: string) {
    this.search.set(value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.debounced.set(value.trim());
      this.page.set(0);
    }, 300);
  }

  protected price(product: ProductSummary): string {
    if (!product.price) return 'Sin precio todavía';
    const list = money(product.price.listPrice, product.price.currency);
    return product.price.promoPrice
      ? `${list} · promo ${money(product.price.promoPrice, product.price.currency)}`
      : list;
  }

  protected async open(product: ProductSummary) {
    this.selected.set(product.sku);
    this.detail.set(null);
    try {
      const detail = await firstValueFrom(this.api.product(product.sku));
      // Si mientras tanto se abrió otro producto, esta respuesta llegó tarde: no pisa el detalle.
      if (this.selected() === product.sku) this.detail.set(detail);
    } catch {
      if (this.selected() !== product.sku) return;
      this.notify.show('No pudimos cargar el producto.');
      this.selected.set(null);
    }
  }

  protected close() {
    this.selected.set(null);
    this.detail.set(null);
  }

  protected async refresh(sku: string) {
    this.refreshing.set(true);
    try {
      const result = await firstValueFrom(this.api.refresh(sku));
      this.detail.set(result.product);
      if (result.errorCode) this.notify.show(readErrorLabel(result.errorCode));
      else
        this.notify.success(
          result.fetched ? 'Precio actualizado desde la web.' : 'El precio ya estaba al día.',
        );
      this.products.reload();
    } catch (error) {
      const status = error instanceof HttpErrorResponse ? error.status : 0;
      this.notify.show(
        status === 429
          ? 'Actualizaste muchos precios seguidos: esperá un minuto.'
          : status === 409
            ? 'Falta configurar el catálogo o el producto no tiene link.'
            : 'No pudimos actualizar el precio.',
      );
    } finally {
      this.refreshing.set(false);
    }
  }
}
