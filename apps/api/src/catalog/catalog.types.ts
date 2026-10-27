// Tipos del catálogo que comparten la base, el lector de páginas, las herramientas del agente y los evals.
import type { CatalogUnit } from '@ventas/shared';

export type SnapshotSource = 'web' | 'excel';
export type AvailabilityValue = 'in_stock' | 'out_of_stock' | 'unknown';

export interface ProductRecord {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  unit: CatalogUnit;
  /** Texto decimal canónico ("2.02"). */
  unitsPerPackage: string | null;
  piecesPerPackage: number | null;
  url: string | null;
  attributes: Record<string, string | number | boolean>;
}

export interface SnapshotRecord {
  id: string;
  productId: string;
  source: SnapshotSource;
  readAt: Date;
  ok: boolean;
  errorCode: string | null;
  listPrice: string | null;
  promoPrice: string | null;
  promoCondition: string | null;
  priceNoTaxes: string | null;
  currency: string;
  priceUnit: string | null;
  unitsPerPackage: string | null;
  piecesPerPackage: number | null;
  availability: AvailabilityValue;
  description: string | null;
  extra: Record<string, string>;
}

export type NewSnapshot = Omit<SnapshotRecord, 'id' | 'productId' | 'readAt'> & {
  fieldSources: Record<string, string>;
  finalUrl: string | null;
  httpStatus: number | null;
};

export interface SearchQuery {
  /** Palabras ya normalizadas (sin tildes, minúsculas), con los sinónimos sumados. */
  terms: string[];
  /** El texto de la búsqueda normalizado, para los trigramas. */
  text: string;
  limit: number;
  /** Texto decimal: solo productos con un precio de referencia menor o igual. */
  maxPrice: string | null;
  order: 'relevance' | 'price_asc' | 'price_desc';
  priceSources: SnapshotSource[];
  /** El precio de referencia considera la promo (price_policy promo o both). */
  usePromo: boolean;
}

export interface SearchHit {
  product: ProductRecord;
  /** Fecha del snapshot del precio de referencia (nunca el monto: no sale hacia el modelo). */
  priceReadAt: Date | null;
}

/** Acceso al catálogo de UNA empresa (la de la conversación). Postgres en producción, memoria en evals. */
export interface CatalogStore {
  findProduct(sku: string): Promise<ProductRecord | null>;
  latestSnapshot(productId: string, source: SnapshotSource, okOnly: boolean): Promise<SnapshotRecord | null>;
  insertSnapshot(productId: string, snapshot: NewSnapshot): Promise<SnapshotRecord>;
  search(query: SearchQuery): Promise<SearchHit[]>;
}
