// Lector de .xlsx (tarea 007, ajuste 2): exportaciones de LibreOffice (real), Excel y Google Sheets (XML
// armado a mano con la forma que escribe cada uno: build-xlsx-fixtures.ts) y otros generadores. Strings
// compartidos y en línea, huecos en las referencias, fechas, números con formato, celdas combinadas, varias
// hojas y archivos que no son .xlsx. Datos inventados.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readXlsx, SpreadsheetError } from '../src/catalog/import/xlsx-reader.js';

const DIR = join(import.meta.dirname, 'fixtures/catalog');
const fixture = (name: string) => readFileSync(join(DIR, name));

function errorOf(fn: () => unknown): SpreadsheetError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SpreadsheetError) return error;
    throw error;
  }
  throw new Error('no falló');
}

describe('exportación real de LibreOffice', () => {
  const sheet = readXlsx(fixture('catalogo-libreoffice.xlsx'));

  it('lee la primera hoja y lista todas', () => {
    expect(sheet.sheetNames).toEqual(['Productos', 'Notas']);
    expect(sheet.name).toBe('Productos');
  });

  it('strings compartidos, números con formato (moneda), fecha y una fila vacía en el medio', () => {
    expect(sheet.rows[1]).toEqual([]);
    expect(sheet.rows[2]).toEqual([
      'Código',
      'Descripción',
      'Rubro',
      'Unidad',
      'M2 x caja',
      'Piezas x caja',
      'Precio',
      'Link',
      'Fecha alta',
      'Observaciones',
    ]);
    expect(sheet.rows[3]).toEqual([
      'CER-001',
      'Cerámica Símil Madera Roble 45x45',
      'Cerámicos',
      'm2',
      2.02,
      10,
      37290,
      'https://www.ceramicos-del-sur.test/p/cer-001',
      '2026-03-15',
      'Esmaltada, apta interior',
    ]);
  });

  it('celdas combinadas en horizontal (título) y en vertical (rubro); celdas vacías como null', () => {
    expect(sheet.rows[0]).toEqual(Array(4).fill('Lista de precios (inventada)'));
    expect(sheet.rows[4]![2]).toBe('Cerámicos');
    expect(sheet.rows[4]![5]).toBeNull();
    // Un número escrito como texto queda como texto (lo interpreta la normalización).
    expect(sheet.rows[4]![6]).toBe('21.450,50');
  });

  it('otra hoja por nombre', () => {
    expect(readXlsx(fixture('catalogo-libreoffice.xlsx'), { sheet: 'Notas' }).rows).toEqual([
      ['Hoja de notas'],
    ]);
  });
});

describe('estilo Excel', () => {
  const sheet = readXlsx(fixture('catalogo-estilo-excel.xlsx'));

  it('corridas de formato, guía fonética ignorada y entidades XML', () => {
    expect(sheet.rows[3]![1]).toBe('Cerámica Símil Madera Roble 45x45');
    expect(sheet.rows[4]![1]).toBe('Pegamento & pastina <gris>');
  });

  it('números con formato (#,##0.00 y moneda), fórmula con su valor guardado y error #N/A', () => {
    expect(sheet.rows[3]![4]).toBe(2.02);
    expect(sheet.rows[3]![5]).toBe(37290);
    expect(sheet.rows[3]![6]).toBe('https://www.ceramicos-del-sur.test/p/cer-001');
    expect(sheet.rows[4]![5]).toBe(11187);
    expect(sheet.rows[4]![6]).toBeNull();
  });

  it('fechas con formato predefinido (14) y propio (dd/mm/yyyy)', () => {
    expect(sheet.rows[3]![7]).toBe('2026-03-15');
    expect(sheet.rows[4]![7]).toBe('2026-03-19');
  });

  it('huecos en columnas y filas, un código numérico y un booleano', () => {
    expect(sheet.rows[4]![0]).toBe(12345);
    expect(sheet.rows[4]![3]).toBe('m2');
    expect(sheet.rows[4]![4]).toBeNull();
    expect(sheet.rows[5]).toEqual([]);
    expect(sheet.rows[6]).toEqual([true]);
  });

  it('celdas combinadas (título y categoría en vertical)', () => {
    expect(sheet.rows[0]).toEqual(Array(4).fill('Lista de precios (inventada)'));
    expect(sheet.rows[4]![2]).toBe('Cerámicos');
  });

  it('varias hojas', () => {
    expect(sheet.sheetNames).toEqual(['Lista', 'Otra hoja']);
    expect(readXlsx(fixture('catalogo-estilo-excel.xlsx'), { sheet: 'Otra hoja' }).rows).toEqual([
      ['Rubro', 42],
    ]);
  });
});

describe('estilo Google Sheets', () => {
  it('la hoja del catálogo no es la primera; fecha con formato d/m/yyyy y decimales binarios', () => {
    const sheet = readXlsx(fixture('catalogo-estilo-google-sheets.xlsx'), { sheet: 'Catálogo' });
    expect(sheet.sheetNames).toEqual(['Portada', 'Catálogo']);
    expect(sheet.rows[1]).toEqual([
      'POR-010',
      'Porcelanato Nórdico Gris 60x60',
      'https://ceramicos-del-sur.test/p/por-010',
      1.44,
      45990.5,
      '2026-03-15',
    ]);
  });
});

describe('otros generadores', () => {
  it('strings en línea con corridas, prefijo x:, celdas sin referencia y destino absoluto', () => {
    const sheet = readXlsx(fixture('catalogo-inline-sin-referencias.xlsx'));
    expect(sheet.rows).toEqual([
      ['Código', 'Nombre', 'Precio'],
      ['PEG-100', 'Pegamento para porcelanato 30 kg', 9800],
    ]);
  });
});

describe('archivos que no son .xlsx: error claro', () => {
  it.each([
    ['catalogo-libreoffice.xls', 'not_xlsx_xls'],
    ['catalogo-libreoffice.csv', 'not_xlsx_csv'],
    ['catalogo-libreoffice.ods', 'not_xlsx_ods'],
  ])('%s → %s, "guardalo como .xlsx"', (name, code) => {
    const error = errorOf(() => readXlsx(fixture(name)));
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/guardalo como \.xlsx/);
  });

  it('un zip cualquiera o un binario', () => {
    expect(errorOf(() => readXlsx(zipSync({ 'hola.txt': strToU8('hola') }))).code).toBe('not_xlsx');
    expect(errorOf(() => readXlsx(new Uint8Array([0, 1, 2, 3, 4, 5]))).code).toBe('not_xlsx');
  });

  it('una hoja que no existe', () => {
    expect(errorOf(() => readXlsx(fixture('catalogo-estilo-excel.xlsx'), { sheet: 'Nada' })).code).toBe(
      'sheet_not_found',
    );
  });
});

describe('límites', () => {
  it('archivo demasiado grande', () => {
    expect(
      errorOf(() => readXlsx(fixture('catalogo-estilo-excel.xlsx'), { limits: { maxFileBytes: 100 } })).code,
    ).toBe('too_large');
  });

  it('bomba zip: lo descomprimido pasa el tope → too_large sin descomprimir', () => {
    const base = fixture('catalogo-inline-sin-referencias.xlsx');
    expect(errorOf(() => readXlsx(base, { limits: { maxUncompressedBytes: 500 } })).code).toBe('too_large');
    // 30 MB de ceros comprimen a pocos KB.
    const bomb = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="r"><sheets><sheet name="H" sheetId="1" r:id="R1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="R1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': new Uint8Array(30 * 1024 * 1024),
    });
    expect(bomb.byteLength).toBeLessThan(200_000);
    expect(errorOf(() => readXlsx(bomb, { limits: { maxUncompressedBytes: 10 * 1024 * 1024 } })).code).toBe(
      'too_large',
    );
  });

  it('demasiadas filas o columnas', () => {
    expect(
      errorOf(() => readXlsx(fixture('catalogo-estilo-excel.xlsx'), { limits: { maxRows: 3 } })).code,
    ).toBe('too_many_rows');
    expect(
      errorOf(() => readXlsx(fixture('catalogo-estilo-excel.xlsx'), { limits: { maxColumns: 5 } })).code,
    ).toBe('too_many_columns');
  });

  it('XML con entidades externas: no se resuelven', () => {
    const xxe = zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="r"><sheets><sheet name="H" sheetId="1" r:id="R1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="R1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&e;</t></is></c></row></sheetData></worksheet>',
      ),
    });
    const sheet = readXlsx(xxe);
    expect(JSON.stringify(sheet.rows)).not.toMatch(/root:/);
  });
});
