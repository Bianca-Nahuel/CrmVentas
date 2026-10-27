// CatalogStore en memoria para los evals y los tests unitarios: mismo contrato que PgCatalogStore, sin
// base. La búsqueda imita la de Postgres (palabras con prefijo y sinónimos, más trigramas sobre el nombre
// para los errores de tipeo); el ranking no es idéntico, alcanza para probar el agente.
import { randomUUID } from 'node:crypto';
import { normalizeText } from '@ventas/shared';
import { compare } from './decimal.js';
import type {
  CatalogStore,
  NewSnapshot,
  ProductRecord,
  SearchHit,
  SearchQuery,
  SnapshotRecord,
  SnapshotSource,
} from './catalog.types.js';

function trigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let index = 0; index < padded.length - 2; index++) grams.add(padded.slice(index, index + 3));
  }
  return grams;
}

/** Como word_similarity de pg_trgm: qué parte de los trigramas de la búsqueda está en el texto. */
function wordSimilarity(query: string, text: string): number {
  const wanted = trigrams(query);
  if (wanted.size === 0) return 0;
  const have = trigrams(text);
  let shared = 0;
  for (const gram of wanted) if (have.has(gram)) shared++;
  return shared / wanted.size;
}

export class MemoryCatalogStore implements CatalogStore {
  readonly products: (ProductRecord & { active: boolean })[] = [];
  readonly snapshots: SnapshotRecord[] = [];

  /** Reloj de las lecturas nuevas (los evals y los tests fijan la fecha). */
  constructor(private readonly now: () => Date = () => new Date()) {}

  addProduct(product: Omit<ProductRecord, 'id'> & { id?: string; active?: boolean }): ProductRecord {
    const record = { ...product, id: product.id ?? randomUUID(), active: product.active ?? true };
    this.products.push(record);
    return record;
  }

  addSnapshot(snapshot: Omit<SnapshotRecord, 'id'> & { id?: string }): SnapshotRecord {
    const record = { ...snapshot, id: snapshot.id ?? randomUUID() };
    this.snapshots.push(record);
    return record;
  }

  async findProduct(sku: string): Promise<ProductRecord | null> {
    return this.products.find((product) => product.sku === sku && product.active) ?? null;
  }

  async latestSnapshot(
    productId: string,
    source: SnapshotSource,
    okOnly: boolean,
  ): Promise<SnapshotRecord | null> {
    return (
      this.snapshots
        .filter((s) => s.productId === productId && s.source === source && (s.ok || !okOnly))
        .sort((a, b) => b.readAt.getTime() - a.readAt.getTime())[0] ?? null
    );
  }

  async insertSnapshot(productId: string, snapshot: NewSnapshot): Promise<SnapshotRecord> {
    const { fieldSources: _sources, finalUrl: _url, httpStatus: _status, ...rest } = snapshot;
    return this.addSnapshot({ ...rest, productId, readAt: this.now() });
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const hits: (SearchHit & { relevance: number; price: string | null })[] = [];
    for (const product of this.products.filter((p) => p.active)) {
      const name = normalizeText(product.name);
      const words = normalizeText(
        [product.name, product.category ?? '', ...Object.values(product.attributes).map(String)].join(' '),
      ).split(/[^a-z0-9]+/);
      const matched = query.terms.filter((term) => words.some((word) => word.startsWith(term))).length;
      const similarity = wordSimilarity(query.text, name);
      if (matched === 0 && similarity < 0.4) continue;
      const reference = (
        await Promise.all(query.priceSources.map((source) => this.latestSnapshot(product.id, source, true)))
      )
        .filter((s): s is SnapshotRecord => s !== null)
        .sort((a, b) => b.readAt.getTime() - a.readAt.getTime())[0];
      const candidates = [reference?.listPrice, query.usePromo ? reference?.promoPrice : null].filter(
        (value): value is string => !!value,
      );
      const price = candidates.sort(compare)[0] ?? null;
      if (query.maxPrice !== null && (price === null || compare(price, query.maxPrice) > 0)) continue;
      hits.push({ product, priceReadAt: reference?.readAt ?? null, relevance: matched + similarity, price });
    }
    const byPrice = (direction: 1 | -1) => (a: (typeof hits)[number], b: (typeof hits)[number]) => {
      if (a.price === null) return b.price === null ? 0 : 1;
      if (b.price === null) return -1;
      return direction * compare(a.price, b.price) || b.relevance - a.relevance;
    };
    hits.sort(
      query.order === 'price_asc'
        ? byPrice(1)
        : query.order === 'price_desc'
          ? byPrice(-1)
          : (a, b) => b.relevance - a.relevance || a.product.name.localeCompare(b.product.name),
    );
    return hits.slice(0, query.limit + 1).map(({ product, priceReadAt }) => ({ product, priceReadAt }));
  }
}
