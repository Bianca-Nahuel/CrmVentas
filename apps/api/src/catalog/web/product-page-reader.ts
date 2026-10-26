// ProductPageReader (tarea 007): lee la página de un producto con caché, extrae los campos, aplica los
// controles de cordura y guarda la lectura (ok o no) como snapshot. Si la lectura no sirve, devuelve la
// última válida (con su fecha). Al modelo nunca le llega el HTML.
import { Logger } from '@nestjs/common';
import type { CatalogConfig } from '@ventas/shared';
import type { CatalogStore, NewSnapshot, ProductRecord, SnapshotRecord } from '../catalog.types.js';
import { extractProduct } from './extract.js';
import { checkSanity } from './sanity.js';
import type { FetchResult } from './safe-fetch.js';

/** SafeFetcher en producción; los evals usan uno que no sale a la red. */
export interface HtmlFetcher {
  fetchHtml(url: string, allowedDomains: readonly string[]): Promise<FetchResult>;
}

export interface PageReadResult {
  /** La lectura válida a usar (nueva o de la caché), o null si nunca hubo una. */
  snapshot: SnapshotRecord | null;
  /** Se leyó la página en esta llamada. */
  fetched: boolean;
  /** Código de la lectura que falló en esta llamada (si falló). */
  errorCode: string | null;
}

export class ProductPageReader {
  private readonly logger = new Logger('ProductPageReader');

  constructor(
    private readonly fetcher: HtmlFetcher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(
    store: CatalogStore,
    catalog: CatalogConfig,
    product: ProductRecord,
    options: { force?: boolean } = {},
  ): Promise<PageReadResult> {
    const lastOk = await store.latestSnapshot(product.id, 'web', true);
    const maxAgeMs = catalog.max_price_age_minutes * 60_000;
    if (!options.force && lastOk && this.now().getTime() - lastOk.readAt.getTime() < maxAgeMs) {
      return { snapshot: lastOk, fetched: false, errorCode: null };
    }
    if (!product.url) return { snapshot: lastOk, fetched: false, errorCode: 'no_url' };

    const page = await this.fetcher.fetchHtml(product.url, catalog.allowed_domains);
    if (!page.ok) {
      await store.insertSnapshot(
        product.id,
        failed(page.errorCode, catalog, page.finalUrl ?? null, page.status ?? null),
      );
      this.warn(product, page.errorCode);
      return { snapshot: lastOk, fetched: true, errorCode: page.errorCode };
    }

    const extraction = extractProduct(page.html, catalog.extractor);
    const sanity = checkSanity(
      extraction.fields,
      lastOk
        ? {
            list_price: lastOk.listPrice ?? undefined,
            promo_price: lastOk.promoPrice ?? undefined,
            price_no_taxes: lastOk.priceNoTaxes ?? undefined,
          }
        : null,
      catalog.max_price_change_pct,
    );
    const fields = sanity.fields;
    const snapshot: NewSnapshot = {
      source: 'web',
      ok: sanity.ok,
      errorCode: sanity.errorCode,
      listPrice: fields.list_price ?? null,
      promoPrice: fields.promo_price ?? null,
      promoCondition: fields.promo_condition ?? null,
      priceNoTaxes: fields.price_no_taxes ?? null,
      currency: fields.currency ?? catalog.currency,
      priceUnit: fields.price_unit ?? product.unit,
      // Fuera de rango para la base (numeric(12,4), integer): se descarta el dato, no la lectura.
      unitsPerPackage:
        fields.units_per_package && Number(fields.units_per_package) < 100_000
          ? fields.units_per_package
          : null,
      piecesPerPackage:
        fields.pieces_per_package && fields.pieces_per_package < 100_000 ? fields.pieces_per_package : null,
      availability: fields.availability ?? 'unknown',
      description: fields.description ?? null,
      extra: {},
      fieldSources: {
        ...extraction.sources,
        ...Object.fromEntries(sanity.dropped.map((field) => [field, 'dropped'])),
      },
      finalUrl: page.finalUrl.slice(0, 2048),
      httpStatus: page.status,
    };
    // Una lectura con montos imposibles para la base (mal formados) se guarda sin ellos.
    const saved = await store.insertSnapshot(product.id, sanity.ok ? snapshot : stripInvalid(snapshot));
    if (!sanity.ok) {
      this.warn(product, sanity.errorCode!);
      return { snapshot: lastOk, fetched: true, errorCode: sanity.errorCode };
    }
    return { snapshot: saved, fetched: true, errorCode: null };
  }

  private warn(product: ProductRecord, errorCode: string): void {
    // Sin URL ni contenido: el id del producto y el código alcanzan para buscarlo.
    this.logger.warn({ msg: 'catalog-read', productId: product.id, errorCode });
  }
}

function failed(
  errorCode: string,
  catalog: CatalogConfig,
  finalUrl: string | null,
  httpStatus: number | null,
): NewSnapshot {
  return {
    source: 'web',
    ok: false,
    errorCode: errorCode.slice(0, 40),
    listPrice: null,
    promoPrice: null,
    promoCondition: null,
    priceNoTaxes: null,
    currency: catalog.currency,
    priceUnit: null,
    unitsPerPackage: null,
    piecesPerPackage: null,
    availability: 'unknown',
    description: null,
    extra: {},
    fieldSources: {},
    finalUrl: finalUrl?.slice(0, 2048) ?? null,
    httpStatus,
  };
}

/** En una lectura rechazada, los precios que no cumplen los CHECK de la base (≤ 0, más de 2 decimales). */
function stripInvalid(snapshot: NewSnapshot): NewSnapshot {
  const valid = (value: string | null) =>
    value !== null && /^\d{1,12}(\.\d{1,2})?$/.test(value) && !/^0+(\.0+)?$/.test(value) ? value : null;
  return {
    ...snapshot,
    listPrice: valid(snapshot.listPrice),
    promoPrice: valid(snapshot.promoPrice),
    priceNoTaxes: valid(snapshot.priceNoTaxes),
  };
}
