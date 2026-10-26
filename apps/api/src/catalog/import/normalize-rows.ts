// De una hoja del Excel a filas de catálogo normalizadas y validadas (tarea 007). Sin base de datos: lo
// usan la importación y los tests. El contenido de las celdas es dato no confiable: se guarda como texto,
// nunca se interpreta.
import { CATALOG_UNITS, normalizeText, wwwVariant, type CatalogUnit } from '@ventas/shared';
import { z } from 'zod';
import { canonical, parseArNumber } from '../decimal.js';
import type { CellValue } from './xlsx-reader.js';

/** Campos del producto a los que se puede mapear una columna. El resto va a attributes. */
export const IMPORT_FIELDS = [
  'sku',
  'name',
  'url',
  'category',
  'unit',
  'units_per_package',
  'pieces_per_package',
  'price',
  'stock',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_LIMITS = {
  maxRows: 5_000,
  maxCellChars: 1_000,
  maxHeaderChars: 100,
  maxAttributes: 60,
} as const;

export const mappingSchema = z
  .object({
    sheet: z.string().trim().min(1).max(100).optional(),
    // Fila de los encabezados (1 = la primera). Sin ella, se busca en las primeras 20.
    header_row: z.number().int().min(1).max(50).optional(),
    // Campo → encabezado tal como está en el archivo.
    columns: z
      .object(
        Object.fromEntries(
          IMPORT_FIELDS.map((field) => [
            field,
            z.string().trim().min(1).max(IMPORT_LIMITS.maxHeaderChars).optional(),
          ]),
        ) as Record<ImportField, z.ZodOptional<z.ZodString>>,
      )
      .strict()
      .refine((columns) => columns.sku && columns.name, 'sku y name son obligatorios'),
  })
  .strict();
export type ImportMapping = z.infer<typeof mappingSchema>;

/** Encabezados conocidos (normalizados) para proponer el mapeo cuando no hay uno guardado. */
const KNOWN_HEADERS: Record<ImportField, string[]> = {
  sku: ['sku', 'codigo', 'cod', 'cod_articulo', 'codigo_articulo', 'codigo_producto', 'id_producto'],
  name: ['nombre', 'descripcion', 'producto', 'detalle', 'nombre_producto'],
  url: ['url', 'link', 'enlace', 'pagina', 'pagina_web', 'link_web'],
  category: ['categoria', 'rubro', 'familia', 'linea'],
  unit: ['unidad', 'unidad_venta', 'unidad_de_venta', 'um'],
  units_per_package: [
    'm2_x_caja',
    'm2_por_caja',
    'm2_caja',
    'metros_por_caja',
    'unidades_por_caja',
    'rendimiento',
  ],
  pieces_per_package: ['piezas_x_caja', 'piezas_por_caja', 'piezas', 'pzas_x_caja'],
  price: ['precio', 'precio_lista', 'precio_de_lista', 'pvp', 'precio_m2', 'precio_x_m2'],
  stock: ['stock', 'disponible', 'disponibilidad', 'existencia'],
};

const UNIT_ALIASES: Record<string, CatalogUnit> = {
  m2: 'm2',
  'm²': 'm2',
  mt2: 'm2',
  mts2: 'm2',
  'metro cuadrado': 'm2',
  'metros cuadrados': 'm2',
  ml: 'ml',
  'metro lineal': 'ml',
  u: 'unit',
  un: 'unit',
  unid: 'unit',
  unidad: 'unit',
  unidades: 'unit',
  unit: 'unit',
  caja: 'box',
  cj: 'box',
  box: 'box',
  kg: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  l: 'l',
  lt: 'l',
  litro: 'l',
  litros: 'l',
};

export const SKU_PATTERN = /^[A-Za-z0-9._/-]{1,64}$/;
/** URL https con solo ASCII imprimible (sin espacios): la misma regla que el CHECK de la base (0013). */
export const SAFE_URL = /^https:\/\/[!-~]{1,2040}$/;

/** "M2 x caja" → "m2_x_caja". Clave estable para attributes (y para comparar encabezados). */
export function normalizeHeader(header: string): string {
  const key = normalizeText(header.replace(/²/g, '2'))
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
  if (key === '') return '';
  return /^[a-z]/.test(key) ? key : `c_${key}`.slice(0, 40);
}

function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim() : String(value);
}

/** La fila de encabezados: la indicada, o la primera (de las 20 primeras) con dos encabezados conocidos. */
export function findHeaderRow(rows: CellValue[][], mapping?: ImportMapping): number | null {
  if (mapping?.header_row) return mapping.header_row - 1;
  const limit = Math.min(rows.length, 20);
  for (let index = 0; index < limit; index++) {
    const keys = (rows[index] ?? []).map((cell) => normalizeHeader(cellText(cell)));
    if (mapping) {
      const wanted = [mapping.columns.sku!, mapping.columns.name!].map(normalizeHeader);
      if (wanted.every((key) => keys.includes(key))) return index;
      continue;
    }
    const known = keys.filter((key) => Object.values(KNOWN_HEADERS).some((list) => list.includes(key)));
    if (known.length >= 2) return index;
  }
  return null;
}

/** Propone un mapeo por los encabezados conocidos. null si no encuentra sku y nombre. */
export function proposeMapping(headers: string[]): ImportMapping | null {
  const columns: Partial<Record<ImportField, string>> = {};
  for (const field of IMPORT_FIELDS) {
    const header = headers.find((candidate) => KNOWN_HEADERS[field].includes(normalizeHeader(candidate)));
    if (header) columns[field] = header;
  }
  if (!columns.sku || !columns.name) return null;
  return { columns };
}

export interface NormalizedProduct {
  sku: string;
  name: string;
  category: string | null;
  unit: CatalogUnit;
  units_per_package: string | null;
  pieces_per_package: number | null;
  url: string | null;
  /** Precio del Excel (texto decimal) si la columna está mapeada. */
  price: string | null;
  availability: 'in_stock' | 'out_of_stock' | 'unknown' | null;
  attributes: Record<string, string | number | boolean>;
}

export interface NormalizedRow {
  /** Número de fila en la planilla (1 = la primera). */
  rowNumber: number;
  sku: string | null;
  status: 'valid' | 'invalid';
  errors: string[];
  data: NormalizedProduct | Record<string, unknown>;
}

export interface NormalizeResult {
  headerRow: number;
  headers: string[];
  rows: NormalizedRow[];
  /** Encabezados del mapeo que no están en el archivo. */
  missingHeaders: string[];
}

function parseNumberCell(value: CellValue | undefined): string | null | 'bad' {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return canonical(value) ?? 'bad';
  if (typeof value === 'boolean') return 'bad';
  return parseArNumber(value) ?? 'bad';
}

function parseStock(value: CellValue | undefined): NormalizedProduct['availability'] | 'bad' {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'in_stock' : 'out_of_stock';
  if (typeof value === 'number') return value > 0 ? 'in_stock' : 'out_of_stock';
  const text = normalizeText(value);
  if (['si', 'hay', 'disponible', 'en stock', 'con stock'].includes(text)) return 'in_stock';
  if (['no', 'sin stock', 'agotado', 'no disponible'].includes(text)) return 'out_of_stock';
  const number = parseArNumber(value);
  if (number !== null) return number === '0' ? 'out_of_stock' : 'in_stock';
  return 'bad';
}

/**
 * Valida la URL de un producto contra los dominios permitidos. null = válida. La URL se escribe tal cual en
 * el mensaje al cliente ({{link:SKU}}): solo ASCII imprimible y en su forma canónica (la que devuelve
 * new URL().href), así no puede llevar espacios raros (NBSP, U+200B…) con texto pegado atrás.
 */
export function urlError(raw: string, allowedDomains: readonly string[]): string | null {
  if (/^http:\/\//i.test(raw)) return 'url_not_https';
  if (!SAFE_URL.test(raw)) return 'url_invalid';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url_invalid';
  }
  if (url.href !== raw) return 'url_not_canonical';
  if (url.protocol !== 'https:') return 'url_not_https';
  if (url.username || url.password || (url.port && url.port !== '443')) return 'url_invalid';
  const host = url.hostname.replace(/\.$/, '');
  if (allowedDomains.includes(host)) return null;
  // La variante con o sin www de un dominio permitido: se avisa aparte, con el dominio a agregar.
  if (allowedDomains.includes(wwwVariant(host))) return 'url_domain_www_variant';
  return 'url_domain';
}

export function normalizeRows(
  rows: CellValue[][],
  mapping: ImportMapping,
  options: { allowedDomains: readonly string[] },
): NormalizeResult {
  const headerIndex = findHeaderRow(rows, mapping);
  if (headerIndex === null) {
    return {
      headerRow: 0,
      headers: [],
      rows: [],
      missingHeaders: [mapping.columns.sku!, mapping.columns.name!],
    };
  }
  const headers = (rows[headerIndex] ?? []).map(cellText);
  const keys = headers.map(normalizeHeader);
  const columnOf = new Map<ImportField, number>();
  const missingHeaders: string[] = [];
  for (const field of IMPORT_FIELDS) {
    const header = mapping.columns[field];
    if (!header) continue;
    const index = keys.indexOf(normalizeHeader(header));
    if (index === -1) missingHeaders.push(header);
    else columnOf.set(field, index);
  }

  // Claves de attributes: el resto de las columnas con encabezado, sin repetir.
  const mapped = new Set(columnOf.values());
  const attributeKeys = new Map<number, string>();
  const used = new Set<string>();
  keys.forEach((key, index) => {
    if (mapped.has(index) || key === '') return;
    let unique = key;
    for (let n = 2; used.has(unique); n++) unique = `${key.slice(0, 37)}_${n}`;
    used.add(unique);
    if (attributeKeys.size < IMPORT_LIMITS.maxAttributes) attributeKeys.set(index, unique);
  });

  const result: NormalizedRow[] = [];
  const skuRows = new Map<string, NormalizedRow[]>();
  for (let index = headerIndex + 1; index < rows.length; index++) {
    const row = rows[index] ?? [];
    if (row.every((cell) => cellText(cell) === '')) continue;
    const errors: string[] = [];
    const get = (field: ImportField) => (columnOf.has(field) ? row[columnOf.get(field)!] : undefined);
    const text = (field: ImportField, max: number = IMPORT_LIMITS.maxCellChars) => {
      const value = cellText(get(field));
      if (value.length > max) {
        errors.push(`cell_too_long:${field}`);
        return '';
      }
      return value;
    };

    const sku = text('sku', 64);
    if (sku === '') errors.push('missing_sku');
    else if (!SKU_PATTERN.test(sku)) errors.push('bad_sku');
    const name = text('name', 300);
    if (name === '') errors.push('missing_name');
    const category = text('category', 120) || null;

    const unitText = normalizeText(text('unit', 40));
    const unit: CatalogUnit | undefined = unitText === '' ? 'unit' : UNIT_ALIASES[unitText];
    if (!unit) errors.push('bad_unit');

    const unitsPerPackage = parseNumberCell(get('units_per_package'));
    // numeric(12,4) en la base: como mucho 8 dígitos enteros.
    const uppOk =
      unitsPerPackage === null ||
      (unitsPerPackage !== 'bad' && unitsPerPackage !== '0' && Number(unitsPerPackage) < 1e8);
    if (!uppOk) errors.push('bad_number:units_per_package');
    const pieces = parseNumberCell(get('pieces_per_package'));
    const piecesOk = pieces === null || (pieces !== 'bad' && /^[1-9]\d{0,6}$/.test(pieces));
    if (!piecesOk) errors.push('bad_number:pieces_per_package');
    const price = parseNumberCell(get('price'));
    if (price === 'bad' || price === '0') errors.push('bad_number:price');
    const stock = parseStock(get('stock'));
    if (stock === 'bad') errors.push('bad_value:stock');

    const url = text('url', 2048) || null;
    if (url) {
      const error = urlError(url, options.allowedDomains);
      if (error) errors.push(error);
    }

    const attributes: Record<string, string | number | boolean> = {};
    for (const [column, key] of attributeKeys) {
      const value = row[column];
      if (value === null || value === undefined || value === '') continue;
      if (typeof value === 'string' && value.length > IMPORT_LIMITS.maxCellChars) {
        errors.push(`cell_too_long:${key}`);
        continue;
      }
      attributes[key] = typeof value === 'string' ? value.trim() : value;
    }

    const data: NormalizedProduct = {
      sku,
      name,
      category,
      unit: unit ?? 'unit',
      units_per_package: uppOk ? unitsPerPackage : null,
      pieces_per_package: piecesOk && pieces !== null ? Number(pieces) : null,
      url,
      price: price === 'bad' ? null : price,
      availability: stock === 'bad' ? null : stock,
      attributes,
    };
    const normalized: NormalizedRow = {
      rowNumber: index + 1,
      sku: sku || null,
      status: errors.length > 0 ? 'invalid' : 'valid',
      errors,
      data,
    };
    result.push(normalized);
    if (sku) skuRows.set(sku, [...(skuRows.get(sku) ?? []), normalized]);
  }

  // SKU repetido en el archivo: todas sus filas quedan inválidas (no se sabe cuál vale).
  for (const repeated of skuRows.values()) {
    if (repeated.length < 2) continue;
    for (const row of repeated) {
      row.errors.push('duplicate_sku');
      row.status = 'invalid';
    }
  }
  if (result.length > IMPORT_LIMITS.maxRows) {
    throw new Error(`La hoja tiene más de ${IMPORT_LIMITS.maxRows} filas de productos.`);
  }
  return { headerRow: headerIndex + 1, headers, rows: result, missingHeaders };
}

/** Explicación de un código de error de fila, para la vista previa. */
export function describeRowError(code: string, allowedDomains: readonly string[]): string {
  const [kind, detail] = code.split(':');
  switch (kind) {
    case 'missing_sku':
      return 'falta el código (SKU)';
    case 'bad_sku':
      return 'el código tiene caracteres no permitidos (letras, números, . _ / -; hasta 64)';
    case 'duplicate_sku':
      return 'el código está repetido en el archivo';
    case 'missing_name':
      return 'falta el nombre';
    case 'bad_unit':
      return `unidad desconocida (se acepta: ${CATALOG_UNITS.join(', ')})`;
    case 'bad_number':
      return `número mal formado en ${detail} (formato argentino: 37.290 o 2,02; "2.02" es ambiguo)`;
    case 'bad_value':
      return `valor no reconocido en ${detail}`;
    case 'url_not_https':
      return 'la URL no es https';
    case 'url_invalid':
      return 'la URL no es válida (solo https, sin espacios ni caracteres especiales)';
    case 'url_not_canonical':
      return 'la URL no está en su forma normal (por ejemplo, el dominio en mayúsculas o caracteres sin codificar): copiala tal como aparece en el navegador';
    case 'url_domain':
      return `la URL no es de un dominio permitido (${allowedDomains.join(', ')})`;
    case 'url_domain_www_variant':
      return 'la URL va a la variante con o sin www de un dominio permitido que no está en catalog.allowed_domains: agregala a la lista o corregí la URL';
    case 'cell_too_long':
      return `celda demasiado larga en ${detail}`;
    default:
      return code;
  }
}
