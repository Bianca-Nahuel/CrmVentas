// Lo que las herramientas del catálogo devolvieron en ESTE turno (tarea 007). Las marcas de la respuesta
// ({{precio:SKU:lista}}…) solo valen para productos de acá, y su valor sale de acá (de la base o de la
// lectura de la web hecha en el turno), nunca del modelo. También registra qué se consultó y qué se citó
// para ai_runs (sin texto del cliente).
import { CATALOG_UNITS, type CatalogConfig, type CatalogUnit } from '@ventas/shared';
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
  /** Cantidades (canónicas) que calculó calcular_cantidad, por SKU. */
  private readonly quantities = new Map<string, string[]>();
  readonly consulted: Consultation[] = [];
  /** Números (canónicos) que escribió el cliente en la conversación: los m² de una marca cajas salen de acá. */
  clientNumbers: string[] = [];
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

  /**
   * Fuente de los datos comerciales (unidad, m² y piezas por caja): la web, salvo que la empresa cite
   * precios del Excel (price_source 'excel'). El Excel puede estar desactualizado: con la web como fuente,
   * si la página no los muestra, no se usan los del Excel (no se calculan cajas y se deriva).
   */
  private fromExcel(): boolean {
    return this.catalog.price_source === 'excel';
  }

  /** m² (o unidades) y piezas por caja, de la lectura de la web del turno (o del Excel, ver fromExcel). */
  perPackage(sku: string): { units: string | null; pieces: number | null } {
    if (this.fromExcel()) {
      const product = this.products.get(sku);
      return { units: product?.unitsPerPackage ?? null, pieces: product?.piecesPerPackage ?? null };
    }
    const web = this.views.get(sku)?.web;
    return { units: web?.unitsPerPackage ?? null, pieces: web?.piecesPerPackage ?? null };
  }

  /** Unidad de venta: la que muestra la web en el precio ("$37.290 x m²"), o la del Excel (ver fromExcel). */
  unitOf(sku: string): CatalogUnit | undefined {
    const product = this.products.get(sku);
    if (!product) return undefined;
    if (this.fromExcel()) return product.unit;
    const web = this.views.get(sku)?.web?.priceUnit;
    return web && (CATALOG_UNITS as readonly string[]).includes(web) ? (web as CatalogUnit) : undefined;
  }

  noteCalculated(sku: string, quantity: string): void {
    this.quantities.set(sku, [...(this.quantities.get(sku) ?? []), quantity]);
  }

  calculated(sku: string): string[] {
    return this.quantities.get(sku) ?? [];
  }

  cite(citation: Citation): void {
    this.cited.push(citation);
  }

  get used(): boolean {
    return this.consulted.length > 0;
  }
}
