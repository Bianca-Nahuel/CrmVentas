// Lo que las herramientas del catálogo devolvieron en ESTE turno (tarea 007). Las marcas de la respuesta
// ({{precio:SKU:lista}}…) solo valen para productos de acá, y su valor sale de acá (de la base o de la
// lectura de la web hecha en el turno), nunca del modelo. También registra qué se consultó y qué se citó
// para ai_runs (sin texto del cliente).
import type { CatalogConfig } from '@ventas/shared';
import type { ProductView } from '../../catalog/catalog-viewer.js';
import type { ProductRecord, SnapshotSource } from '../../catalog/catalog.types.js';

export interface Consultation {
  tool: 'buscar_productos' | 'ver_producto' | 'calcular_cantidad';
  sku: string;
  snapshot_id?: string;
  price_source?: SnapshotSource;
}

export interface Citation {
  kind: 'precio' | 'link' | 'cajas' | 'stock' | 'por_caja';
  sku: string;
  price_type?: 'lista' | 'promo';
  snapshot_id?: string;
  source?: SnapshotSource;
}

export class TurnCatalogContext {
  private readonly products = new Map<string, ProductRecord>();
  private readonly views = new Map<string, ProductView>();
  readonly consulted: Consultation[] = [];
  readonly cited: Citation[] = [];

  constructor(
    readonly catalog: CatalogConfig,
    readonly now: Date,
    readonly timezone: string,
  ) {}

  noteFound(tool: Consultation['tool'], product: ProductRecord): void {
    this.products.set(product.sku, product);
    this.consulted.push({ tool, sku: product.sku });
  }

  noteView(view: ProductView): void {
    this.products.set(view.product.sku, view.product);
    this.views.set(view.product.sku, view);
    this.consulted.push({
      tool: 'ver_producto',
      sku: view.product.sku,
      ...(view.price ? { snapshot_id: view.price.snapshot.id, price_source: view.price.source } : {}),
    });
  }

  product(sku: string): ProductRecord | undefined {
    return this.products.get(sku);
  }

  view(sku: string): ProductView | undefined {
    return this.views.get(sku);
  }

  /** m² (o unidades) por caja: el del Excel o, si no está, el de la última lectura de la web del turno. */
  perPackage(sku: string): { units: string | null; pieces: number | null } {
    const product = this.products.get(sku);
    const web = this.views.get(sku)?.web;
    return {
      units: product?.unitsPerPackage ?? web?.unitsPerPackage ?? null,
      pieces: product?.piecesPerPackage ?? web?.piecesPerPackage ?? null,
    };
  }

  cite(citation: Citation): void {
    this.cited.push(citation);
  }

  get used(): boolean {
    return this.consulted.length > 0;
  }
}
