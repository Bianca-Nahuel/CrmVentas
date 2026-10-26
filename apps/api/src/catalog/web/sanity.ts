// Controles de cordura de una lectura de la web (tarea 007): si no pasan, la lectura se guarda con
// ok = false y su código, y se sigue usando la última válida (con su fecha).
import { changedMoreThan, compare, decimals, isPositive } from '../decimal.js';
import type { ExtractedFields } from './extract.js';

const PRICE_FIELDS = ['list_price', 'promo_price', 'price_no_taxes'] as const;
const MAX_PRICE = '1000000000';
// Una condición de promo se escribe tal cual en el mensaje al cliente: sin links, emails ni teléfonos.
const UNSAFE_CONDITION = /https?:|www\.|@|\b[a-z0-9-]+\.(com|ar|net|org)\b|\d[\d\s().-]{7,}\d|[{}<>]/i;

export type SanityError = 'no_price' | 'bad_price' | 'promo_above_list' | 'bad_no_taxes' | 'price_jump';

export interface SanityResult {
  ok: boolean;
  errorCode: SanityError | null;
  /** Los campos que se guardan (sin los descartados). */
  fields: ExtractedFields;
  /** Campos descartados sin invalidar la lectura (ej. una condición de promo con un link). */
  dropped: string[];
}

export function checkSanity(
  extracted: ExtractedFields,
  previousOk: Pick<ExtractedFields, 'list_price' | 'promo_price' | 'price_no_taxes'> | null,
  maxChangePct: number,
): SanityResult {
  const fields: ExtractedFields = { ...extracted };
  const dropped: string[] = [];
  const fail = (errorCode: SanityError): SanityResult => ({ ok: false, errorCode, fields, dropped });

  // Una promo sin condición segura no se puede mostrar: se descartan las dos (el precio de lista sigue).
  if (fields.promo_condition !== undefined && UNSAFE_CONDITION.test(fields.promo_condition)) {
    delete fields.promo_condition;
    delete fields.promo_price;
    dropped.push('promo_condition', 'promo_price');
  }

  if (fields.list_price === undefined && fields.promo_price === undefined) return fail('no_price');
  for (const field of PRICE_FIELDS) {
    const value = fields[field];
    if (value === undefined) continue;
    if (!isPositive(value) || decimals(value) > 2 || compare(value, MAX_PRICE) > 0) return fail('bad_price');
  }
  if (fields.list_price && fields.promo_price && compare(fields.promo_price, fields.list_price) > 0) {
    return fail('promo_above_list');
  }
  const highest = fields.list_price ?? fields.promo_price!;
  if (fields.price_no_taxes && compare(fields.price_no_taxes, highest) > 0) return fail('bad_no_taxes');

  if (previousOk) {
    for (const field of PRICE_FIELDS) {
      const before = previousOk[field];
      const after = fields[field];
      if (before && after && changedMoreThan(before, after, maxChangePct)) return fail('price_jump');
    }
  }
  return { ok: true, errorCode: null, fields, dropped };
}
