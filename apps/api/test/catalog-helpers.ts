// Ayudas de los tests del catálogo (tarea 007). Datos inventados; dominios .test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogConfigSchema, type CatalogConfig } from '@ventas/shared';

type ExtractorConfigInput = NonNullable<z.input<typeof catalogConfigSchema>['extractor']>;
import { strToU8, zipSync } from 'fflate';
import type { z } from 'zod';
import type { FetchResult } from '../src/catalog/web/safe-fetch.js';
import type { HtmlFetcher } from '../src/catalog/web/product-page-reader.js';

export const SHOP = 'ceramicos-del-sur.test';
export const HTML_DIR = join(import.meta.dirname, 'fixtures/catalog/html');
export const html = (name: string) => readFileSync(join(HTML_DIR, name), 'utf8');

/** Extractor para el HTML de prueba que imita la página de producto de una casa de cerámicos. */
export const TEST_EXTRACTOR: ExtractorConfigInput = {
  fields: {
    list_price: { selector: '.price--list', parse: 'price_ar' },
    price_unit: { selector: '.price--list small', regex: 'x\\s*(m²|m2|unidad)' },
    promo_price: { selector: '.price--promo .amount', parse: 'price_ar' },
    promo_condition: { selector: '.price--promo .badge' },
    price_no_taxes: { selector: '.price-no-tax', regex: '\\$\\s*([\\d.,]+)', parse: 'price_ar' },
    units_per_package: { selector: 'ul.specs', regex: 'm²\\s*por caja\\s*([\\d.,]+)', parse: 'number_ar' },
    pieces_per_package: { selector: 'ul.specs', regex: 'Piezas por caja\\s*(\\d+)', parse: 'integer' },
    description: { selector: '.description' },
  },
};

export function catalogConfig(overrides: Partial<z.input<typeof catalogConfigSchema>> = {}): CatalogConfig {
  return catalogConfigSchema.parse({
    enabled: true,
    allowed_domains: [SHOP, `www.${SHOP}`],
    price_policy: { quote: 'both', show_no_taxes: false, note: 'Precio sujeto a cambios.' },
    max_price_age_minutes: 60,
    availability_source: 'none',
    extractor: TEST_EXTRACTOR,
    synonyms: [{ term: 'piso', equivalents: ['porcelanato', 'ceramica'] }],
    key_attributes: ['formato', 'color'],
    ...overrides,
  });
}

/** Fetcher falso: devuelve HTML por URL y cuenta los pedidos. */
export class FakeFetcher implements HtmlFetcher {
  calls: string[] = [];
  pages = new Map<string, FetchResult>();

  page(url: string, body: string): this {
    this.pages.set(url, { ok: true, html: body, finalUrl: url, status: 200 });
    return this;
  }

  async fetchHtml(url: string): Promise<FetchResult> {
    this.calls.push(url);
    return this.pages.get(url) ?? { ok: false, errorCode: 'http_status', status: 404 };
  }
}

/** Un .xlsx mínimo con strings en línea y números, para los tests de importación. */
export function buildXlsx(rows: (string | number | null)[][]): Uint8Array {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const columnName = (index: number) => String.fromCharCode(65 + index);
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === null) return '';
          const ref = `${columnName(c)}${r + 1}`;
          return typeof value === 'number'
            ? `<c r="${ref}"><v>${value}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    ),
    'xl/workbook.xml': strToU8(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Lista" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  });
}
