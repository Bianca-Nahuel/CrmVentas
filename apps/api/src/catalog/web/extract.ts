// Extracción de los datos de un producto desde el HTML de su página (tarea 007). Por campo, el primero
// que da un valor válido, en este orden: JSON-LD (Product/Offer), microdatos, metaetiquetas y el extractor
// configurado por la empresa (selectores CSS y expresiones regulares). Una regla con prefer le gana a los
// datos estructurados. El HTML nunca sale de acá: solo los campos ya parseados.
import {
  normalizeText,
  type CatalogUnit,
  type ExtractorConfig,
  type ExtractorField,
  type ExtractorParser,
} from '@ventas/shared';
import { selectAll as cssSelectAll } from 'css-select';
import type { AnyNode, Element } from 'domhandler';
import { getAttributeValue, textContent } from 'domutils';
import { parseDocument } from 'htmlparser2';
import { parseArNumber, parseDotNumber } from '../decimal.js';

export type FieldSource = 'jsonld' | 'microdata' | 'meta' | 'extractor';
export type Availability = 'in_stock' | 'out_of_stock';

export interface ExtractedFields {
  list_price?: string;
  promo_price?: string;
  promo_condition?: string;
  price_no_taxes?: string;
  price_unit?: CatalogUnit;
  units_per_package?: string;
  pieces_per_package?: number;
  availability?: Availability;
  description?: string;
  currency?: string;
}
type FieldKey = keyof ExtractedFields;

export interface Extraction {
  fields: ExtractedFields;
  sources: Partial<Record<FieldKey, FieldSource>>;
  /** Para dev:test-extractor: el texto que encontró cada regla del extractor antes de parsear. */
  matched: Partial<Record<ExtractorField, string>>;
  /** Reglas que no se pudieron aplicar (selector inválido, sin coincidencias, valor que no parsea). */
  ruleIssues: string[];
  /** Solo para mostrar en dev:test-extractor. */
  title: string | null;
}

const MAX_JSONLD_CHARS = 200_000;

/** css-select con el tipo de domhandler (sus tipos genéricos no lo infieren). */
function selectAll(selector: string, root: AnyNode | AnyNode[]): Element[] {
  return cssSelectAll(selector, root) as Element[];
}
const MAX_JSONLD_SCRIPTS = 20;
const MAX_RULE_TEXT = 20_000;
/** Texto sobre el que corre una regex de la empresa (acota el costo de un backtracking malo). */
const MAX_REGEX_TEXT = 2_000;
const LIMITS: Partial<Record<FieldKey, number>> = { promo_condition: 120, description: 1_000 };

const DEFAULT_PARSER: Record<ExtractorField, ExtractorParser> = {
  list_price: 'price_ar',
  promo_price: 'price_ar',
  price_no_taxes: 'price_ar',
  units_per_package: 'number_ar',
  pieces_per_package: 'integer',
  promo_condition: 'text',
  price_unit: 'text',
  availability: 'text',
  description: 'text',
};

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** El primer número en formato argentino de un texto ("$37.290 x m²" → "37290"). */
export function firstArNumber(text: string): string | null {
  // El primer número completo (dígitos con sus separadores, no pegado a una letra como el 2 de "m2"), y se
  // interpreta entero: "2.02" o "37290.50" no son formato argentino y no se cortan en "2" o "37290", quedan
  // sin valor y la regla se informa.
  const match = /(?<![\p{L}\d.,])\d(?:[\d.,]*\d)?/u.exec(text);
  return match ? parseArNumber(match[0]) : null;
}

export function normalizeUnit(text: string): CatalogUnit | undefined {
  const value = normalizeText(text).replace(/²/g, '2');
  if (/\b(m2|mt2|mts2|metros? cuadrados?)\b/.test(value)) return 'm2';
  if (/\b(ml|metros? lineal(es)?)\b/.test(value)) return 'ml';
  if (/\b(cajas?|box)\b/.test(value)) return 'box';
  if (/\b(kg|kilos?)\b/.test(value)) return 'kg';
  if (/\b(litros?|lts?)\b/.test(value)) return 'l';
  if (/\b(unidad(es)?|unid|u|un|pieza)\b/.test(value)) return 'unit';
  return undefined;
}

/** schema.org (InStock, https://schema.org/OutOfStock…) o frases del availability_map. */
export function normalizeAvailability(
  text: string,
  map?: ExtractorConfig['availability_map'],
): Availability | undefined {
  const value = normalizeText(text);
  const bare = value.replace(/^https?:\/\/(www\.)?schema\.org\//, '');
  if (['instock', 'instoreonly', 'onlineonly', 'limitedavailability'].includes(bare)) return 'in_stock';
  if (['outofstock', 'soldout', 'discontinued'].includes(bare)) return 'out_of_stock';
  if (map?.out_of_stock.some((phrase) => value.includes(normalizeText(phrase)))) return 'out_of_stock';
  if (map?.in_stock.some((phrase) => value.includes(normalizeText(phrase)))) return 'in_stock';
  return undefined;
}

/** Convierte el texto de un campo a su valor. undefined = no parsea. */
function parseField(
  field: FieldKey,
  text: string,
  parser: ExtractorParser,
  map?: ExtractorConfig['availability_map'],
) {
  const value = collapse(text);
  if (value === '') return undefined;
  if (field === 'availability') return normalizeAvailability(value, map);
  if (field === 'price_unit') return normalizeUnit(value);
  switch (parser) {
    case 'price_ar':
    case 'number_ar':
      return firstArNumber(value) ?? undefined;
    case 'integer': {
      const match = /\d{1,7}/.exec(value);
      return match ? Number(match[0]) : undefined;
    }
    case 'text': {
      const max = LIMITS[field] ?? 200;
      // Una descripción larga se corta; cualquier otro texto demasiado largo no es lo que se buscaba.
      if (field === 'description') return value.slice(0, max);
      return value.length > max ? undefined : value;
    }
  }
}

// ---- JSON-LD ------------------------------------------------------------------------------------------------
function typesOf(node: Record<string, unknown>): string[] {
  const type = node['@type'];
  return (Array.isArray(type) ? type : [type]).filter((item): item is string => typeof item === 'string');
}

function findProduct(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProduct(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const node = value as Record<string, unknown>;
  if (typesOf(node).some((type) => /(^|\/)Product$/.test(type))) return node;
  for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
    const found = findProduct(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function fromJsonLd(scripts: string[]): Partial<ExtractedFields> {
  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script);
    } catch {
      continue;
    }
    const product = findProduct(parsed);
    if (!product) continue;
    const fields: Partial<ExtractedFields> = {};
    const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    if (offers && typeof offers === 'object') {
      const offer = offers as Record<string, unknown>;
      const spec = offer.priceSpecification as Record<string, unknown> | undefined;
      const price = parseDotNumber(offer.price ?? offer.lowPrice ?? spec?.price);
      if (price) fields.list_price = price;
      const currency = offer.priceCurrency ?? spec?.priceCurrency;
      if (typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)) fields.currency = currency;
      if (typeof offer.availability === 'string') {
        const availability = normalizeAvailability(offer.availability);
        if (availability) fields.availability = availability;
      }
    }
    if (typeof product.description === 'string') {
      const description = parseField('description', product.description, 'text');
      if (typeof description === 'string') fields.description = description;
    }
    return fields;
  }
  return {};
}

// ---- Microdatos y metaetiquetas -----------------------------------------------------------------------------
function itempropValue(node: Element): string {
  return getAttributeValue(node, 'content') ?? getAttributeValue(node, 'href') ?? textContent(node);
}

function fromMicrodata(doc: AnyNode[]): Partial<ExtractedFields> {
  const scope = selectAll('[itemscope][itemtype*="schema.org/Product" i]', doc)[0];
  if (!scope) return {};
  const fields: Partial<ExtractedFields> = {};
  const prop = (name: string) => selectAll(`[itemprop="${name}"]`, scope)[0];
  const price = prop('price') ?? prop('lowPrice');
  if (price) {
    const value = parseDotNumber(itempropValue(price).trim());
    if (value) fields.list_price = value;
  }
  const currency = prop('priceCurrency');
  if (currency && /^[A-Z]{3}$/.test(itempropValue(currency).trim()))
    fields.currency = itempropValue(currency).trim();
  const availability = prop('availability');
  if (availability) {
    const value = normalizeAvailability(itempropValue(availability));
    if (value) fields.availability = value;
  }
  const description = prop('description');
  if (description) {
    const value = parseField('description', itempropValue(description), 'text');
    if (typeof value === 'string') fields.description = value;
  }
  return fields;
}

function fromMeta(doc: AnyNode[]): Partial<ExtractedFields> {
  const fields: Partial<ExtractedFields> = {};
  const meta = (...names: string[]) => {
    for (const name of names) {
      const node = selectAll(`meta[property="${name}" i], meta[name="${name}" i]`, doc)[0];
      const content = node ? getAttributeValue(node, 'content') : undefined;
      if (content && content.trim()) return content.trim();
    }
    return undefined;
  };
  const price = meta('product:price:amount', 'og:price:amount');
  if (price) {
    const value = parseDotNumber(price);
    if (value) fields.list_price = value;
  }
  const currency = meta('product:price:currency', 'og:price:currency');
  if (currency && /^[A-Z]{3}$/.test(currency)) fields.currency = currency;
  const availability = meta('product:availability', 'og:availability');
  if (availability) {
    const value = normalizeAvailability(availability);
    if (value) fields.availability = value;
  }
  return fields;
}

// ---- Extractor de la empresa -------------------------------------------------------------------------------
function fromExtractor(doc: AnyNode[], extractor: ExtractorConfig | null) {
  const fields: Partial<ExtractedFields> = {};
  const matched: Partial<Record<ExtractorField, string>> = {};
  const issues: string[] = [];
  const preferred = new Set<FieldKey>();
  if (!extractor) return { fields, matched, issues, preferred };
  for (const [field, rule] of Object.entries(extractor.fields) as [
    ExtractorField,
    NonNullable<ExtractorConfig['fields'][ExtractorField]>,
  ][]) {
    if (!rule) continue;
    let nodes: Element[];
    try {
      nodes = selectAll(rule.selector, doc);
    } catch {
      issues.push(`${field}: selector inválido`);
      continue;
    }
    const node = nodes[rule.index];
    if (!node) {
      issues.push(`${field}: el selector no encontró nada`);
      continue;
    }
    let text = (rule.attribute ? getAttributeValue(node, rule.attribute) : textContent(node)) ?? '';
    text = collapse(text).slice(0, MAX_RULE_TEXT);
    if (rule.regex) {
      const match = new RegExp(rule.regex, 'iu').exec(text.slice(0, MAX_REGEX_TEXT));
      if (!match) {
        issues.push(`${field}: la expresión regular no coincidió`);
        continue;
      }
      text = match[1] ?? match[0];
    }
    matched[field] = text.slice(0, 200);
    const value = parseField(field, text, rule.parse ?? DEFAULT_PARSER[field], extractor.availability_map);
    if (value === undefined) {
      issues.push(`${field}: el valor no se pudo interpretar`);
      continue;
    }
    (fields as Record<string, unknown>)[field] = value;
    if (rule.prefer) preferred.add(field);
  }
  return { fields, matched, issues, preferred };
}

export function extractProduct(html: string, extractor: ExtractorConfig | null): Extraction {
  const doc = parseDocument(html, { decodeEntities: true }).children;
  const scripts = selectAll('script[type="application/ld+json" i]', doc)
    .slice(0, MAX_JSONLD_SCRIPTS)
    .map((node) => textContent(node))
    .filter((text) => text.length <= MAX_JSONLD_CHARS);
  const layers: [FieldSource, Partial<ExtractedFields>][] = [
    ['jsonld', fromJsonLd(scripts)],
    ['microdata', fromMicrodata(doc)],
    ['meta', fromMeta(doc)],
  ];
  const custom = fromExtractor(doc, extractor);

  const fields: ExtractedFields = {};
  const sources: Extraction['sources'] = {};
  const keys = new Set<FieldKey>([
    ...layers.flatMap(([, layer]) => Object.keys(layer) as FieldKey[]),
    ...(Object.keys(custom.fields) as FieldKey[]),
  ]);
  for (const key of keys) {
    const order: [FieldSource, Partial<ExtractedFields>][] = custom.preferred.has(key)
      ? [['extractor', custom.fields], ...layers]
      : [...layers, ['extractor', custom.fields]];
    for (const [source, layer] of order) {
      if (layer[key] !== undefined) {
        (fields as Record<string, unknown>)[key] = layer[key];
        sources[key] = source;
        break;
      }
    }
  }

  const titleNode = selectAll('h1', doc)[0];
  const title = titleNode ? collapse(textContent(titleNode)).slice(0, 200) : null;
  return { fields, sources, matched: custom.matched, ruleIssues: custom.issues, title };
}

/** Valida los selectores de un extractor (al cargar la config). Devuelve los que no compilan. */
export function invalidSelectors(extractor: ExtractorConfig | null | undefined): string[] {
  if (!extractor) return [];
  const doc = parseDocument('<html></html>').children;
  const invalid: string[] = [];
  for (const [field, rule] of Object.entries(extractor.fields)) {
    if (!rule) continue;
    try {
      selectAll(rule.selector, doc);
    } catch {
      invalid.push(field);
    }
  }
  return invalid;
}
