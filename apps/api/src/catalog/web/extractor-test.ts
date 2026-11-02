// Prueba del extractor de una empresa contra la página de un producto (tareas 007 y 027): lo usan
// `dev:test-extractor` y POST /api/catalog/extractor/test. Hace UN pedido con las mismas protecciones que
// producción (el HtmlFetcher es el SafeFetcher: solo allowed_domains, https, IP pública, 2 MB, 8 s). Devuelve
// cada campo con su origen y lo que encontró cada regla (texto recortado), nunca el HTML. No guarda nada.
import type { CatalogConfig } from '@ventas/shared';
import { extractProduct, type FieldSource } from './extract.js';
import type { HtmlFetcher } from './product-page-reader.js';
import { checkSanity } from './sanity.js';

export const EXTRACTOR_TEST_FIELDS = [
  'list_price',
  'promo_price',
  'promo_condition',
  'price_no_taxes',
  'currency',
  'price_unit',
  'units_per_package',
  'pieces_per_package',
  'availability',
  'description',
] as const;

/** Largo máximo de cada texto que vuelve (valor, texto encontrado por la regla, título). */
const MAX_TEXT = 200;

export interface ExtractorTestField {
  field: (typeof EXTRACTOR_TEST_FIELDS)[number];
  value: string | null;
  source: FieldSource | null;
  /** Texto que encontró la regla del extractor (solo si el valor salió de ella). */
  matched: string | null;
}

export type ExtractorTestResult =
  | {
      ok: true;
      finalUrl: string;
      httpStatus: number;
      title: string | null;
      fields: ExtractorTestField[];
      ruleIssues: string[];
      sanity: { ok: boolean; errorCode: string | null; dropped: string[] };
      /** availability_source es web pero la página no informa disponibilidad. */
      noAvailability: boolean;
    }
  | { ok: false; errorCode: string; httpStatus: number | null };

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

export async function testExtractor(
  fetcher: HtmlFetcher,
  url: string,
  catalog: CatalogConfig,
): Promise<ExtractorTestResult> {
  const page = await fetcher.fetchHtml(url, catalog.allowed_domains);
  if (!page.ok) return { ok: false, errorCode: page.errorCode, httpStatus: page.status ?? null };

  const extraction = extractProduct(page.html, catalog.extractor);
  const fields = EXTRACTOR_TEST_FIELDS.map((field): ExtractorTestField => {
    const value = extraction.fields[field];
    const source = extraction.sources[field] ?? null;
    const matched = extraction.matched[field as keyof typeof extraction.matched];
    return {
      field,
      value: value === undefined ? null : clip(String(value)),
      source,
      matched: matched && source === 'extractor' ? clip(matched) : null,
    };
  });
  const sanity = checkSanity(extraction.fields, null, catalog.max_price_change_pct);
  return {
    ok: true,
    finalUrl: page.finalUrl.slice(0, 2048),
    httpStatus: page.status,
    title: extraction.title ? clip(extraction.title) : null,
    fields,
    ruleIssues: extraction.ruleIssues.map(clip),
    sanity: { ok: sanity.ok, errorCode: sanity.errorCode, dropped: sanity.dropped },
    noAvailability: catalog.availability_source === 'web' && extraction.fields.availability === undefined,
  };
}
