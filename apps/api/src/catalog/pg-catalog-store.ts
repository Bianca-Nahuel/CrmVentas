// CatalogStore sobre Postgres: cada operación es una transacción corta de ventas_app con la empresa de la
// conversación (RLS). Las herramientas corren mientras el modelo piensa, fuera de la T1 y la T2 del worker.
import { sql } from 'drizzle-orm';
import type { CatalogUnit } from '@ventas/shared';
import type { AppDb } from '../db/pools.js';
import { withTenantTransaction } from '../db/tenant-context.js';
import { canonical } from './decimal.js';
import type {
  CatalogStore,
  NewSnapshot,
  ProductRecord,
  SearchHit,
  SearchQuery,
  SnapshotRecord,
  SnapshotSource,
} from './catalog.types.js';

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  unit: CatalogUnit;
  units_per_package: string | null;
  pieces_per_package: number | null;
  url: string | null;
  attributes: Record<string, string | number | boolean>;
};

type SnapshotRow = {
  id: string;
  product_id: string;
  source: SnapshotSource;
  read_at: Date | string;
  ok: boolean;
  error_code: string | null;
  list_price: string | null;
  promo_price: string | null;
  promo_condition: string | null;
  price_no_taxes: string | null;
  currency: string;
  price_unit: string | null;
  units_per_package: string | null;
  pieces_per_package: number | null;
  availability: SnapshotRecord['availability'];
  description: string | null;
  extra: Record<string, string>;
};

const SNAPSHOT_COLUMNS = sql`id, product_id, source, read_at, ok, error_code, list_price::text AS list_price,
  promo_price::text AS promo_price, promo_condition, price_no_taxes::text AS price_no_taxes, currency, price_unit,
  units_per_package::text AS units_per_package, pieces_per_package, availability, description, extra`;

function toProduct(row: ProductRow): ProductRecord {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    unit: row.unit,
    unitsPerPackage: canonical(row.units_per_package),
    piecesPerPackage: row.pieces_per_package,
    url: row.url,
    attributes: row.attributes ?? {},
  };
}

function toSnapshot(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    productId: row.product_id,
    source: row.source,
    readAt: new Date(row.read_at),
    ok: row.ok,
    errorCode: row.error_code,
    listPrice: canonical(row.list_price),
    promoPrice: canonical(row.promo_price),
    promoCondition: row.promo_condition,
    priceNoTaxes: canonical(row.price_no_taxes),
    currency: row.currency,
    priceUnit: row.price_unit,
    unitsPerPackage: canonical(row.units_per_package),
    piecesPerPackage: row.pieces_per_package,
    availability: row.availability,
    description: row.description,
    extra: row.extra ?? {},
  };
}

export class PgCatalogStore implements CatalogStore {
  constructor(
    private readonly db: AppDb,
    private readonly tenantId: string,
  ) {}

  private tx<T>(fn: Parameters<typeof withTenantTransaction<T>>[2]): Promise<T> {
    return withTenantTransaction(this.db, { tenantId: this.tenantId }, fn);
  }

  findProduct(sku: string): Promise<ProductRecord | null> {
    return this.tx(async (tx) => {
      const result = await tx.execute<ProductRow>(sql`
        SELECT id, sku, name, category, unit, units_per_package::text AS units_per_package, pieces_per_package,
               url, attributes
        FROM catalog_products WHERE sku = ${sku} AND active
      `);
      return result.rows[0] ? toProduct(result.rows[0]) : null;
    });
  }

  latestSnapshot(productId: string, source: SnapshotSource, okOnly: boolean): Promise<SnapshotRecord | null> {
    return this.tx(async (tx) => {
      const result = await tx.execute<SnapshotRow>(sql`
        SELECT ${SNAPSHOT_COLUMNS} FROM product_snapshots
        WHERE product_id = ${productId} AND source = ${source} AND (ok OR NOT ${okOnly})
        ORDER BY read_at DESC, id DESC LIMIT 1
      `);
      return result.rows[0] ? toSnapshot(result.rows[0]) : null;
    });
  }

  insertSnapshot(productId: string, snapshot: NewSnapshot): Promise<SnapshotRecord> {
    return this.tx(async (tx) => {
      const result = await tx.execute<SnapshotRow>(sql`
        INSERT INTO product_snapshots
          (tenant_id, product_id, source, ok, error_code, list_price, promo_price, promo_condition,
           price_no_taxes, currency, price_unit, units_per_package, pieces_per_package, availability, description,
           extra, field_sources, final_url, http_status)
        VALUES (app_tenant_id(), ${productId}, ${snapshot.source}, ${snapshot.ok}, ${snapshot.errorCode},
           ${snapshot.listPrice}, ${snapshot.promoPrice}, ${snapshot.promoCondition}, ${snapshot.priceNoTaxes},
           ${snapshot.currency}, ${snapshot.priceUnit}, ${snapshot.unitsPerPackage}, ${snapshot.piecesPerPackage},
           ${snapshot.availability}, ${snapshot.description}, ${JSON.stringify(snapshot.extra)}::jsonb,
           ${JSON.stringify(snapshot.fieldSources)}::jsonb, ${snapshot.finalUrl}, ${snapshot.httpStatus})
        RETURNING ${SNAPSHOT_COLUMNS}
      `);
      return toSnapshot(result.rows[0]!);
    });
  }

  /**
   * Texto completo (con prefijos y sinónimos) o trigramas sobre el nombre (errores de tipeo). El precio de
   * referencia (último snapshot válido de las fuentes permitidas) solo filtra y ordena: nunca se devuelve.
   */
  search(query: SearchQuery): Promise<SearchHit[]> {
    const terms = query.terms.filter((term) => /^[a-z0-9]{2,40}$/.test(term)).slice(0, 20);
    const tsquery = terms.map((term) => `${term}:*`).join(' | ');
    const order =
      query.order === 'price_asc'
        ? sql`ref.price ASC NULLS LAST, relevance DESC`
        : query.order === 'price_desc'
          ? sql`ref.price DESC NULLS LAST, relevance DESC`
          : sql`relevance DESC, p.name ASC`;
    return this.tx(async (tx) => {
      const result = await tx.execute<ProductRow & { price_read_at: Date | string | null }>(sql`
        WITH q AS (
          SELECT CASE WHEN ${tsquery} = '' THEN NULL ELSE to_tsquery('spanish'::regconfig, ${tsquery}) END AS tsq,
                 ${query.text}::text AS text
        )
        SELECT p.id, p.sku, p.name, p.category, p.unit, p.units_per_package::text AS units_per_package,
               p.pieces_per_package, p.url, p.attributes, ref.read_at AS price_read_at,
               COALESCE(ts_rank_cd(p.search_tsv, q.tsq), 0)
                 + word_similarity(q.text, catalog_unaccent(lower(p.name))) AS relevance
        FROM catalog_products p
        CROSS JOIN q
        LEFT JOIN LATERAL (
          SELECT s.read_at,
                 LEAST(s.list_price, CASE WHEN ${query.usePromo} THEN s.promo_price END) AS price
          FROM product_snapshots s
          WHERE s.product_id = p.id AND s.ok
            AND s.source IN (SELECT jsonb_array_elements_text(${JSON.stringify(query.priceSources)}::jsonb))
          ORDER BY s.read_at DESC, s.id DESC LIMIT 1
        ) ref ON true
        WHERE p.active
          AND ((q.tsq IS NOT NULL AND p.search_tsv @@ q.tsq)
               OR word_similarity(q.text, catalog_unaccent(lower(p.name))) >= 0.4)
          AND (${query.maxPrice}::numeric IS NULL OR ref.price <= ${query.maxPrice}::numeric)
        ORDER BY ${order}
        LIMIT ${query.limit + 1}
      `);
      return result.rows.map((row) => ({
        product: toProduct(row),
        priceReadAt: row.price_read_at ? new Date(row.price_read_at) : null,
      }));
    });
  }
}
