// Lector mínimo de .xlsx (tarea 007) sobre fflate (zip) y saxen (XML). El archivo es input no confiable:
// - se descomprime solo lo necesario y con tope por el tamaño declarado de cada entrada (fflate nunca
//   escribe más allá de ese tamaño, así que una entrada que miente queda cortada, no infla memoria);
// - saxen no resuelve entidades externas ni DTDs (sin XXE);
// - las fórmulas no se evalúan: se usa el último valor que guardó la planilla.
// Lee una hoja: valores de texto (compartidos, en línea, de fórmula), números, booleanos y fechas (como
// AAAA-MM-DD), con huecos en las referencias y celdas combinadas (el valor se repite en todo el rango).
import { unzipSync } from 'fflate';
import { Parser } from 'saxen';

export type CellValue = string | number | boolean | null;

export type SpreadsheetErrorCode =
  | 'not_xlsx_xls'
  | 'not_xlsx_csv'
  | 'not_xlsx_ods'
  | 'not_xlsx'
  | 'too_large'
  | 'too_many_rows'
  | 'too_many_columns'
  | 'sheet_not_found'
  | 'corrupt';

const SAVE_AS_XLSX = 'Abrilo en Excel, LibreOffice o Google Sheets y guardalo como .xlsx.';
const MESSAGES: Record<SpreadsheetErrorCode, string> = {
  not_xlsx_xls: `El archivo es un .xls (Excel 97-2003), no un .xlsx. ${SAVE_AS_XLSX}`,
  not_xlsx_csv: `El archivo parece un .csv (texto), no un .xlsx. ${SAVE_AS_XLSX}`,
  not_xlsx_ods: `El archivo es un .ods (LibreOffice), no un .xlsx. ${SAVE_AS_XLSX}`,
  not_xlsx: `El archivo no es un .xlsx. ${SAVE_AS_XLSX}`,
  too_large: 'El archivo es demasiado grande.',
  too_many_rows: 'La hoja tiene demasiadas filas.',
  too_many_columns: 'La hoja tiene demasiadas columnas.',
  sheet_not_found: 'No existe esa hoja en el archivo.',
  corrupt: 'No se pudo leer el archivo (está dañado o no es un .xlsx válido).',
};

export class SpreadsheetError extends Error {
  constructor(
    readonly code: SpreadsheetErrorCode,
    detail?: string,
  ) {
    super(detail ? `${MESSAGES[code]} ${detail}` : MESSAGES[code]);
    this.name = 'SpreadsheetError';
  }
}

export interface XlsxLimits {
  /** Tamaño del archivo. */
  maxFileBytes: number;
  /** Suma de lo que se descomprime (workbook, strings, estilos y la hoja). */
  maxUncompressedBytes: number;
  /** Filas con algún valor. */
  maxRows: number;
  /** Última columna con algún valor. */
  maxColumns: number;
}

export const DEFAULT_XLSX_LIMITS: XlsxLimits = {
  maxFileBytes: 5 * 1024 * 1024,
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxRows: 5_001,
  maxColumns: 60,
};

export interface XlsxSheet {
  /** Nombres de todas las hojas, en orden. */
  sheetNames: string[];
  name: string;
  /** rows[i] es la fila i + 1 de la planilla; las filas vacías quedan como []. */
  rows: CellValue[][];
}

// Formatos de número predefinidos que son fechas u horas (ECMA-376, 18.8.30).
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

export function readXlsx(data: Uint8Array, options: { sheet?: string; limits?: Partial<XlsxLimits> } = {}) {
  const limits = { ...DEFAULT_XLSX_LIMITS, ...options.limits };
  if (data.byteLength > limits.maxFileBytes) throw new SpreadsheetError('too_large');
  rejectOtherFormats(data);

  const workbookFiles = unzipLimited(
    data,
    (name) =>
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      name === 'xl/styles.xml',
    limits.maxUncompressedBytes,
  );
  const workbookXml = workbookFiles.get('xl/workbook.xml');
  if (!workbookXml) {
    // Un zip que no es un .xlsx: ¿un .ods?
    const names = listEntries(data);
    if (names.includes('content.xml') && names.includes('mimetype'))
      throw new SpreadsheetError('not_xlsx_ods');
    throw new SpreadsheetError('not_xlsx');
  }
  const workbook = parseWorkbook(workbookXml);
  const rels = parseRels(workbookFiles.get('xl/_rels/workbook.xml.rels') ?? '');
  const target = options.sheet
    ? workbook.sheets.find((sheet) => sheet.name === options.sheet)
    : workbook.sheets[0];
  if (!target) throw new SpreadsheetError('sheet_not_found');
  const relTarget = rels.get(target.relId);
  if (!relTarget) throw new SpreadsheetError('corrupt');
  // El destino puede ser relativo a xl/ ("worksheets/sheet1.xml") o absoluto ("/xl/worksheets/sheet1.xml").
  const sheetPath = relTarget.startsWith('/') ? relTarget.slice(1) : `xl/${relTarget}`;

  const used = [...workbookFiles.values()].reduce((total, xml) => total + xml.length, 0);
  const sheetXml = unzipLimited(data, (name) => name === sheetPath, limits.maxUncompressedBytes - used).get(
    sheetPath,
  );
  if (sheetXml === undefined) throw new SpreadsheetError('corrupt');

  const sharedStrings = parseSharedStrings(workbookFiles.get('xl/sharedStrings.xml') ?? '');
  const dateStyles = parseDateStyles(workbookFiles.get('xl/styles.xml') ?? '');
  const rows = parseSheet(sheetXml, { sharedStrings, dateStyles, date1904: workbook.date1904, limits });
  return {
    sheetNames: workbook.sheets.map((sheet) => sheet.name),
    name: target.name,
    rows,
  } satisfies XlsxSheet;
}

function rejectOtherFormats(data: Uint8Array): void {
  const isZip = data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
  if (isZip) return;
  const ole2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (ole2.every((byte, index) => data[index] === byte)) throw new SpreadsheetError('not_xlsx_xls');
  // Texto: sin bytes de control salvo tab y fin de línea en el primer KB, y con separadores de columna.
  const head = data.subarray(0, 1024);
  const textual = head.every((byte) => byte === 9 || byte === 10 || byte === 13 || byte >= 32);
  if (textual && /[,;\t]/.test(Buffer.from(head).toString('utf8')))
    throw new SpreadsheetError('not_xlsx_csv');
  throw new SpreadsheetError('not_xlsx');
}

function listEntries(data: Uint8Array): string[] {
  const names: string[] = [];
  try {
    unzipSync(data, {
      filter: (file) => {
        names.push(file.name);
        return false;
      },
    });
  } catch {
    // corrupto: sin nombres
  }
  return names;
}

function unzipLimited(
  data: Uint8Array,
  wanted: (name: string) => boolean,
  budget: number,
): Map<string, string> {
  let declared = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (file) => {
        if (!wanted(file.name)) return false;
        declared += file.originalSize;
        if (declared > budget) throw new SpreadsheetError('too_large');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof SpreadsheetError) throw error;
    throw new SpreadsheetError('corrupt');
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return new Map(Object.entries(files).map(([name, bytes]) => [name, decoder.decode(bytes)]));
}

/** Sin prefijo de namespace ("x:row" → "row"). */
function local(name: string): string {
  const index = name.indexOf(':');
  return index === -1 ? name : name.slice(index + 1);
}

function attr(attrs: Record<string, string>, name: string): string | undefined {
  if (attrs[name] !== undefined) return attrs[name];
  const key = Object.keys(attrs).find((candidate) => local(candidate) === name);
  return key === undefined ? undefined : attrs[key];
}

function parse(
  xml: string,
  handlers: {
    open?: (name: string, attrs: Record<string, string>, selfClosing: boolean) => void;
    close?: (name: string) => void;
    text?: (text: string) => void;
  },
): void {
  const parser = new Parser();
  parser.on('error', (error) => {
    throw error;
  });
  if (handlers.open) {
    parser.on('openTag', (name, attrs, decode, selfClosing) => {
      const decoded: Record<string, string> = {};
      for (const [key, value] of Object.entries(attrs())) decoded[key] = decode(value);
      handlers.open!(local(name), decoded, selfClosing);
      if (selfClosing) handlers.close?.(local(name));
    });
  }
  if (handlers.close) {
    parser.on('closeTag', (name, _decode, selfClosing) => {
      if (!selfClosing) handlers.close!(local(name));
    });
  }
  if (handlers.text) {
    parser.on('text', (value, decode) => handlers.text!(decode(value)));
    parser.on('cdata', (value) => handlers.text!(value));
  }
  try {
    parser.parse(xml);
  } catch (error) {
    if (error instanceof SpreadsheetError) throw error;
    throw new SpreadsheetError('corrupt');
  }
}

function parseWorkbook(xml: string) {
  const sheets: { name: string; relId: string }[] = [];
  let date1904 = false;
  parse(xml, {
    open: (name, attrs) => {
      if (name === 'sheet') {
        const relId = attr(attrs, 'id');
        if (attrs.name && relId) sheets.push({ name: attrs.name, relId });
      } else if (name === 'workbookPr') {
        date1904 = attrs.date1904 === '1' || attrs.date1904 === 'true';
      }
    },
  });
  return { sheets, date1904 };
}

function parseRels(xml: string): Map<string, string> {
  const rels = new Map<string, string>();
  if (!xml) return rels;
  parse(xml, {
    open: (name, attrs) => {
      if (name === 'Relationship' && attrs.Id && attrs.Target) rels.set(attrs.Id, attrs.Target);
    },
  });
  return rels;
}

/** Strings compartidos: <si><t/></si> o con varias corridas <r><t/></r>. La guía fonética (rPh) no cuenta. */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  if (!xml) return strings;
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  parse(xml, {
    open: (name) => {
      if (name === 'si') current = '';
      else if (name === 'rPh') phonetic++;
      else if (name === 't' && phonetic === 0) inText = true;
    },
    close: (name) => {
      if (name === 'si') {
        strings.push(current ?? '');
        current = null;
      } else if (name === 'rPh') phonetic--;
      else if (name === 't') inText = false;
    },
    text: (text) => {
      if (inText && current !== null) current += text;
    },
  });
  return strings;
}

/** Índices de cellXfs cuyo formato de número es una fecha. */
function parseDateStyles(xml: string): Set<number> {
  const dates = new Set<number>();
  if (!xml) return dates;
  const customDate = new Set<number>();
  let inCellXfs = false;
  let xfIndex = 0;
  parse(xml, {
    open: (name, attrs) => {
      if (name === 'numFmt') {
        const id = Number(attrs.numFmtId);
        if (isDateFormatCode(attrs.formatCode ?? '')) customDate.add(id);
      } else if (name === 'cellXfs') {
        inCellXfs = true;
        xfIndex = 0;
      } else if (name === 'xf' && inCellXfs) {
        const id = Number(attrs.numFmtId ?? 0);
        if (BUILTIN_DATE_FORMATS.has(id) || customDate.has(id)) dates.add(xfIndex);
        xfIndex++;
      }
    },
    close: (name) => {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });
  return dates;
}

/** Un código de formato es de fecha si, sin lo que va entre comillas o corchetes, tiene d, m o y. */
function isDateFormatCode(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[dy]/i.test(bare) || /(^|[^a-z])m+([^a-z]|$)/i.test(bare.replace(/[hs]/gi, ''));
}

/** Número de serie de Excel → AAAA-MM-DD (sistema 1900, o 1904 si el libro lo indica). */
function serialToDate(serial: number, date1904: boolean): string {
  // 25569 = 1970-01-01 en el sistema 1900 (contando el 29/02/1900 que Excel inventó).
  const days = date1904 ? serial + 1462 : serial;
  const ms = Math.round((days - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

/** "B12" → { col: 1, row: 11 } (desde 0). */
function cellRef(ref: string): { col: number; row: number } | null {
  const match = /^([A-Z]{1,3})(\d{1,7})$/.exec(ref.toUpperCase());
  if (!match) return null;
  let col = 0;
  for (const letter of match[1]!) col = col * 26 + (letter.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(match[2]) - 1 };
}

function parseSheet(
  xml: string,
  context: { sharedStrings: string[]; dateStyles: Set<number>; date1904: boolean; limits: XlsxLimits },
): CellValue[][] {
  const rows: CellValue[][] = [];
  const merges: { from: { col: number; row: number }; to: { col: number; row: number } }[] = [];
  let rowIndex = -1;
  let nextCol = 0;
  let nonEmptyRows = 0;
  let rowHasValue = false;
  let cell: {
    col: number;
    type: string;
    style: number;
    value: string;
    inline: string;
    inValue: boolean;
    inInline: boolean;
    phonetic: number;
  } | null = null;

  const set = (row: number, col: number, value: CellValue) => {
    if (value === null || value === '') return;
    if (col >= context.limits.maxColumns) throw new SpreadsheetError('too_many_columns');
    while (rows.length <= row) rows.push([]);
    const target = rows[row]!;
    while (target.length < col) target.push(null);
    target[col] = value;
    rowHasValue = true;
  };

  parse(xml, {
    open: (name, attrs) => {
      if (name === 'row') {
        const r = Number(attrs.r);
        rowIndex = Number.isInteger(r) && r > 0 ? r - 1 : rowIndex + 1;
        nextCol = 0;
        rowHasValue = false;
      } else if (name === 'c') {
        const ref = attrs.r ? cellRef(attrs.r) : null;
        const col = ref ? ref.col : nextCol;
        if (ref) rowIndex = ref.row;
        nextCol = col + 1;
        cell = {
          col,
          type: attrs.t ?? 'n',
          style: Number(attrs.s ?? 0),
          value: '',
          inline: '',
          inValue: false,
          inInline: false,
          phonetic: 0,
        };
      } else if (cell && name === 'v') {
        cell.inValue = true;
      } else if (cell && name === 'rPh') {
        cell.phonetic++;
      } else if (cell && name === 't' && cell.type === 'inlineStr' && cell.phonetic === 0) {
        cell.inInline = true;
      } else if (name === 'mergeCell' && attrs.ref) {
        const [from, to] = attrs.ref.split(':').map(cellRef);
        if (from && to) merges.push({ from, to });
      }
    },
    close: (name) => {
      if (name === 'c' && cell) {
        set(rowIndex, cell.col, cellValue(cell, context));
        cell = null;
      } else if (cell && name === 'v') cell.inValue = false;
      else if (cell && name === 't') cell.inInline = false;
      else if (cell && name === 'rPh') cell.phonetic--;
      else if (name === 'row' && rowHasValue && ++nonEmptyRows > context.limits.maxRows) {
        throw new SpreadsheetError('too_many_rows');
      }
    },
    text: (text) => {
      if (!cell) return;
      if (cell.inValue) cell.value += text;
      else if (cell.inInline) cell.inline += text;
    },
  });

  // Celdas combinadas: el valor de la primera celda vale para todo el rango (por ejemplo, una categoría
  // combinada en vertical para varias filas). Rangos absurdos se ignoran.
  for (const { from, to } of merges) {
    if (to.row - from.row > context.limits.maxRows || to.col >= context.limits.maxColumns) continue;
    const value = rows[from.row]?.[from.col] ?? null;
    if (value === null) continue;
    for (let row = from.row; row <= to.row; row++) {
      for (let col = from.col; col <= to.col; col++) {
        if (row !== from.row || col !== from.col) set(row, col, value);
      }
    }
  }
  return rows;
}

function cellValue(
  cell: { type: string; style: number; value: string; inline: string },
  context: { sharedStrings: string[]; dateStyles: Set<number>; date1904: boolean },
): CellValue {
  switch (cell.type) {
    case 's': {
      const index = Number(cell.value);
      return Number.isInteger(index) ? (context.sharedStrings[index] ?? null) : null;
    }
    case 'inlineStr':
      return cell.inline;
    case 'str':
      return cell.value;
    case 'b':
      return cell.value === '1' || cell.value === 'true';
    case 'e':
      // #N/A, #DIV/0!…: sin valor.
      return null;
    case 'd':
      return /^\d{4}-\d{2}-\d{2}/.test(cell.value) ? cell.value.slice(0, 10) : null;
    default: {
      if (cell.value.trim() === '') return null;
      const number = Number(cell.value);
      if (!Number.isFinite(number)) return null;
      return context.dateStyles.has(cell.style) ? serialToDate(number, context.date1904) : number;
    }
  }
}
