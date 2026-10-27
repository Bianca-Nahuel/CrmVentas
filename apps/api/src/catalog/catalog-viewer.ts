// Lo que se sabe de un producto para responder (tarea 007): qué precio vale según catalog.price_source
// (web, excel o el más reciente) y qué disponibilidad según catalog.availability_source, cada uno con su
// lectura y si está vigente.
import type { CatalogConfig } from '@ventas/shared';
import type { CatalogStore, ProductRecord, SnapshotRecord, SnapshotSource } from './catalog.types.js';
import type { ProductPageReader } from './web/product-page-reader.js';

export interface ProductView {
  product: ProductRecord;
  /** La lectura de la que sale el precio (null si no hay ninguna con precio). */
  price: { snapshot: SnapshotRecord; source: SnapshotSource; current: boolean } | null;
  /** Por qué no hay un precio vigente. */
  priceIssue: 'no_price' | 'stale' | null;
  /** Solo si la empresa informa disponibilidad y la fuente la conoce. */
  availability: { value: 'in_stock' | 'out_of_stock'; snapshot: SnapshotRecord; current: boolean } | null;
  /** Lectura de la web (descripción, m² por caja) si se usó. */
  web: SnapshotRecord | null;
  /** Se leyó la página en esta consulta. */
  fetched: boolean;
}

export function isCurrent(snapshot: SnapshotRecord, catalog: CatalogConfig, now: Date): boolean {
  const ageMs = now.getTime() - snapshot.readAt.getTime();
  const maxMs =
    snapshot.source === 'web'
      ? catalog.max_price_age_minutes * 60_000
      : catalog.excel_max_age_days * 86_400_000;
  return ageMs >= 0 && ageMs < maxMs;
}

const hasPrice = (snapshot: SnapshotRecord | null): snapshot is SnapshotRecord =>
  !!snapshot && (snapshot.listPrice !== null || snapshot.promoPrice !== null);

export class CatalogViewer {
  constructor(
    private readonly reader: ProductPageReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async view(store: CatalogStore, catalog: CatalogConfig, sku: string): Promise<ProductView | null> {
    const product = await store.findProduct(sku);
    if (!product) return null;
    const needWeb = catalog.price_source !== 'excel' || catalog.availability_source === 'web';
    const needExcel = catalog.price_source !== 'web' || catalog.availability_source === 'excel';
    const webRead = needWeb ? await this.reader.read(store, catalog, product) : null;
    const web = webRead?.snapshot ?? null;
    const excel = needExcel ? await store.latestSnapshot(product.id, 'excel', true) : null;
    const now = this.now();

    const priced: SnapshotRecord | null =
      catalog.price_source === 'web'
        ? hasPrice(web)
          ? web
          : null
        : catalog.price_source === 'excel'
          ? hasPrice(excel)
            ? excel
            : null
          : ([web, excel].filter(hasPrice).sort((a, b) => b.readAt.getTime() - a.readAt.getTime())[0] ??
            null);
    const price = priced
      ? { snapshot: priced, source: priced.source, current: isCurrent(priced, catalog, now) }
      : null;

    const availabilitySnapshot =
      catalog.availability_source === 'web' ? web : catalog.availability_source === 'excel' ? excel : null;
    const availability =
      availabilitySnapshot && availabilitySnapshot.availability !== 'unknown'
        ? {
            value: availabilitySnapshot.availability,
            snapshot: availabilitySnapshot,
            current: isCurrent(availabilitySnapshot, catalog, now),
          }
        : null;

    return {
      product,
      price,
      priceIssue: !price ? 'no_price' : price.current ? null : 'stale',
      availability,
      web,
      fetched: webRead?.fetched ?? false,
    };
  }
}
