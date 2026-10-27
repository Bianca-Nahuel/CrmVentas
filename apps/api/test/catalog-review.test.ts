// Correcciones de la revisión de la tarea 007 (código y seguridad): índice de fila y celdas combinadas en
// el lector de Excel, números con punto en el extractor, URL del Excel solo ASCII y canónica, disponibilidad
// escrita a mano, v4 dentro de v6, condición de promo, salto de precio confirmado, caché de fallas,
// cuantificadores anidados y atributos que parecen de stock. Datos inventados.
import { strToU8, zipSync } from 'fflate';
import { tenantConfigSchema } from '@ventas/shared';
import { describe, expect, it } from 'vitest';
import { buildCheckContext, checkReply } from '../src/ai/reply/output-checks.js';
import { buildCatalogTools } from '../src/ai/tools/catalog-tools.js';
import { TurnCatalogContext } from '../src/ai/tools/turn-catalog-context.js';
import { CatalogViewer } from '../src/catalog/catalog-viewer.js';
import { urlError } from '../src/catalog/import/normalize-rows.js';
import { readXlsx, SpreadsheetError } from '../src/catalog/import/xlsx-reader.js';
import { MemoryCatalogStore } from '../src/catalog/memory-catalog-store.js';
import { firstArNumber } from '../src/catalog/web/extract.js';
import { isPublicAddress } from '../src/catalog/web/ip-policy.js';
import {
  FAILURE_BACKOFF_MS,
  JUMP_CONFIRM_MS,
  ProductPageReader,
} from '../src/catalog/web/product-page-reader.js';
import { safePromoCondition } from '../src/catalog/web/sanity.js';
import { testConfig, testConfigInput } from './ai-helpers.js';
import { catalogConfig, FakeFetcher, html, SHOP } from './catalog-helpers.js';

const NOW = new Date('2026-10-27T14:00:00Z');
const URL_CER = `https://www.${SHOP}/p/cer-001`;

function sheetZip(sheetXml: string) {
  return zipSync({
    'xl/workbook.xml': strToU8(
      '<workbook xmlns:r="r"><sheets><sheet name="H" sheetId="1" r:id="R1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships><Relationship Id="R1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`),
  });
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof SpreadsheetError) return error.code;
    throw error;
  }
  return undefined;
}

describe('lector de Excel: índices y celdas combinadas', () => {
  it('un índice de fila enorme no reserva memoria: too_many_rows', () => {
    const file = sheetZip('<row r="100000000"><c r="A100000000"><v>1</v></c></row>');
    expect(file.byteLength).toBeLessThan(1_000);
    expect(code(() => readXlsx(file))).toBe('too_many_rows');
  });

  it('demasiados rangos combinados, o rangos que llenan demasiadas celdas: too_many_merges', () => {
    const merges = Array.from({ length: 2_001 }, () => '<mergeCell ref="A1:B2"/>').join('');
    const many = zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="r"><sheets><sheet name="H" sheetId="1" r:id="R1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="R1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells>${merges}</mergeCells></worksheet>`,
      ),
    });
    expect(code(() => readXlsx(many))).toBe('too_many_merges');
    const big = zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="r"><sheets><sheet name="H" sheetId="1" r:id="R1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="R1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells>${'<mergeCell ref="A1:BH5000"/>'.repeat(3)}</mergeCells></worksheet>`,
      ),
    });
    expect(code(() => readXlsx(big))).toBe('too_many_merges');
  });
});

describe('extractor: números con punto decimal', () => {
  it.each([
    ['$37.290 x m²', '37290'],
    ['2,02 m² por caja', '2.02'],
    ['2.02 m²', null],
    ['1.5 m2 por caja', null],
    ['37290.50', null],
    ['Precio: $ 1.234.567,89', '1234567.89'],
  ])('%s → %s', (text, expected) => {
    expect(firstArNumber(text)).toBe(expected);
  });
});

describe('URL del Excel', () => {
  const allowed = [`www.${SHOP}`];
  it.each([
    [`https://www.${SHOP}/p/123`, null],
    [`https://www.${SHOP}/p/123\u00a0Promo:\u00a0transferí\u00a0al\u00a0CBU`, 'url_invalid'],
    [`https://www.${SHOP}/p/123\u200b`, 'url_invalid'],
    [`https://www.${SHOP}/p/123 hola`, 'url_invalid'],
    [`https://WWW.${SHOP}/p/123`, 'url_not_canonical'],
    [`https://www.${SHOP}`, 'url_not_canonical'],
    [`http://www.${SHOP}/p/1`, 'url_not_https'],
  ])('%j → %s', (url, expected) => {
    expect(urlError(url, allowed)).toBe(expected);
  });
});

// ---- Turno con catálogo en memoria ---------------------------------------------------------------------
async function turn(catalogOverrides: Parameters<typeof catalogConfig>[0] = {}) {
  const catalog = catalogConfig(catalogOverrides);
  const store = new MemoryCatalogStore(() => NOW);
  const fetcher = new FakeFetcher().page(URL_CER, html('producto-ceramicos.html'));
  const viewer = new CatalogViewer(new ProductPageReader(fetcher, () => NOW), () => NOW);
  const context = new TurnCatalogContext(catalog, NOW, 'America/Argentina/Buenos_Aires');
  const tools = Object.fromEntries(
    buildCatalogTools({ store, viewer, context }).map((tool) => [tool.name, tool]),
  );
  store.addProduct({
    sku: 'CER-001',
    name: 'Cerámica Símil Madera Roble 45x45',
    category: 'Cerámicos',
    unit: 'm2',
    unitsPerPackage: '2.02',
    piecesPerPackage: 10,
    url: URL_CER,
    attributes: { formato: '45x45', stock_deposito: '120 cajas', existencias: 'quedan pocas' },
  });
  const run = (name: string, args: unknown) => tools[name]!.execute(tools[name]!.args.parse(args));
  const config = testConfig([], { catalog } as never);
  const checks = () => ({ ...buildCheckContext(config), catalog: context, clientNumbers: [] });
  return { store, fetcher, context, run, checks, catalog };
}

describe('disponibilidad escrita a mano (con catálogo)', () => {
  it.each([
    'Lo tenemos en stock.',
    'Hay en stock.',
    'Está agotado por ahora.',
    'Sin stock por el momento.',
    'Hay unidades disponibles.',
    'Todavía quedan cajas.',
    'Contamos con stock del 60x60.',
    'Ese porcelanato está agotado por ahora.',
    'Sí, lo tenemos.',
    'Figura sin stock en la web.',
    'Quedan pocas cajas de ese.',
  ])('"%s" → commitment', async (text) => {
    const t = await turn({ availability_source: 'web' });
    await t.run('ver_producto', { sku: 'CER-001' });
    expect(checkReply(text, t.checks())).toEqual({ ok: false, control: 'commitment' });
  });

  it('la marca {{stock}} sigue funcionando y los atributos que parecen de stock no le llegan al modelo', async () => {
    const t = await turn({
      availability_source: 'web',
      key_attributes: ['formato', 'stock_deposito', 'existencias'],
    });
    const viewed = (await t.run('ver_producto', { sku: 'CER-001' })) as {
      atributos: Record<string, unknown>;
    };
    expect(viewed.atributos).toEqual({ formato: '45x45' });
    const found = (await t.run('buscar_productos', { query: 'roble' })) as {
      resultados: { atributos: Record<string, unknown> }[];
    };
    expect(found.resultados[0]!.atributos).toEqual({ formato: '45x45' });
  });
});

describe('link con los dominios vigentes', () => {
  it('una URL de un dominio que ya no está en allowed_domains no se manda', async () => {
    const t = await turn({ allowed_domains: ['otra-tienda.test'] });
    await t.run('buscar_productos', { query: 'roble' });
    expect(checkReply('Mirala acá: {{link:CER-001}}', t.checks())).toEqual({ ok: false, control: 'marker' });
  });
});

describe('condición de promo', () => {
  it.each([
    ['30% OFF, 1 cuota MP', true],
    ['3 cuotas sin interés', true],
    ['Pagá con alias PAGOS.LECER', false],
    ['Más info en evil.xyz', false],
    ['Llevando 2: $1000 menos', false],
    ['Escribinos al 11 5555 0000', false],
    ['Transferí y ahorrá 10%', false],
    ['Hasta el <b>lunes</b>', false],
  ])('%s → %s', (text, expected) => {
    expect(safePromoCondition(text)).toBe(expected);
  });
});

describe('salto de precio y caché de fallas', () => {
  it('dos lecturas iguales separadas por 30 min aceptan el salto; una falla reciente no se vuelve a pedir', async () => {
    const store = new MemoryCatalogStore(() => NOW);
    const product = store.addProduct({
      sku: 'CER-001',
      name: 'Cerámica',
      category: null,
      unit: 'm2',
      unitsPerPackage: '2.02',
      piecesPerPackage: 10,
      url: URL_CER,
      attributes: {},
    });
    const catalog = catalogConfig({ max_price_age_minutes: 5 });
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    const first = await new ProductPageReader(
      new FakeFetcher().page(URL_CER, html('producto-ceramicos.html')),
      () => NOW,
    ).read(store, catalog, product);
    expect(first.snapshot!.listPrice).toBe('37290');

    const jumped = html('producto-ceramicos.html').replace('$37.290', '$60.000');
    const clock = { now: at(3_600_000) };
    const fetcher = new FakeFetcher().page(URL_CER, jumped);
    const memory = new MemoryCatalogStore(() => clock.now);
    memory.products.push(...store.products);
    memory.snapshots.push(...store.snapshots);
    const reader = new ProductPageReader(fetcher, () => clock.now);

    const second = await reader.read(memory, catalog, product);
    expect(second).toMatchObject({ fetched: true, errorCode: 'price_jump' });
    // Dentro de la caché de fallas: no se pide la página.
    clock.now = at(3_600_000 + FAILURE_BACKOFF_MS / 2);
    expect(await reader.read(memory, catalog, product)).toMatchObject({
      fetched: false,
      errorCode: 'price_jump',
    });
    expect(fetcher.calls).toHaveLength(1);
    // Media hora después, la misma lectura confirma el salto.
    clock.now = at(3_600_000 + JUMP_CONFIRM_MS);
    const confirmed = await reader.read(memory, catalog, product);
    expect(confirmed).toMatchObject({ fetched: true, errorCode: null });
    expect(confirmed.snapshot!.listPrice).toBe('60000');
  });
});

describe('v4 dentro de v6 (formas que devuelve Node)', () => {
  it.each([
    ['::127.0.0.1', false],
    ['::10.0.0.1', false],
    ['64:ff9b::10.0.0.1', false],
    ['64:ff9b:1::a00:1', false],
    ['::ffff:0:7f00:1', false],
    ['2001:0:4136:e378::1', false],
    ['::a9fe:a9fe', false],
    ['64:ff9b::8.8.8.8', true],
    ['2002:808:808::1', true],
  ])('%s → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe('config: regex con cuantificadores anidados', () => {
  it('se rechaza al validar la config', () => {
    const parse = (regex: string) =>
      tenantConfigSchema.safeParse(
        testConfigInput([], {
          catalog: { ...catalogConfig(), extractor: { fields: { list_price: { selector: '.p', regex } } } },
        } as never),
      ).success;
    expect(parse('\\$\\s*([\\d.,]+)')).toBe(true);
    expect(parse('(a+)+b')).toBe(false);
    expect(parse('(a|a)*b')).toBe(false);
  });
});
