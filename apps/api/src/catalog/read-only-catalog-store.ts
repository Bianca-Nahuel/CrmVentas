// CatalogStore de solo lectura para el playground del panel (tarea 027): lee los productos y las lecturas de
// la empresa (Postgres, con su RLS), pero una lectura nueva de la web queda solo en memoria, para este turno.
// Así una prueba no escribe nada en la base de negocio (ni la caché de precios que usa el agente real).
import { randomUUID } from 'node:crypto';
import type {
  CatalogStore,
  NewSnapshot,
  ProductRecord,
  SearchHit,
  SearchQuery,
  SnapshotRecord,
  SnapshotSource,
} from './catalog.types.js';

export class ReadOnlyCatalogStore implements CatalogStore {
  /** Lecturas hechas en este turno, de la más vieja a la más nueva. */
  private readonly local: SnapshotRecord[] = [];

  constructor(
    private readonly inner: CatalogStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  findProduct(sku: string): Promise<ProductRecord | null> {
    return this.inner.findProduct(sku);
  }

  search(query: SearchQuery): Promise<SearchHit[]> {
    return this.inner.search(query);
  }

  async latestSnapshot(
    productId: string,
    source: SnapshotSource,
    okOnly: boolean,
  ): Promise<SnapshotRecord | null> {
    const local = this.local.findLast(
      (snapshot) =>
        snapshot.productId === productId && snapshot.source === source && (!okOnly || snapshot.ok),
    );
    return local ?? this.inner.latestSnapshot(productId, source, okOnly);
  }

  async insertSnapshot(productId: string, snapshot: NewSnapshot): Promise<SnapshotRecord> {
    const { fieldSources: _sources, finalUrl: _url, httpStatus: _status, ...record } = snapshot;
    const saved: SnapshotRecord = { ...record, id: randomUUID(), productId, readAt: this.now() };
    this.local.push(saved);
    return saved;
  }
}
