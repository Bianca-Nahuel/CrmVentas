// Textos, números y resaltado de citas de Rendimiento (tarea 026). Funciones puras (se prueban sin TestBed).
import type { CustomerOutcome, IssueType } from '../../api/generated';

const LOCALE = 'es-AR';

export const CUSTOMER_OUTCOME_LABELS: Record<CustomerOutcome, string> = {
  satisfied: 'Conforme',
  neutral: 'Neutro',
  dissatisfied: 'Disconforme',
  unknown: 'No se sabe',
};

export const ISSUE_LABELS: Record<IssueType, string> = {
  info_incorrecta: 'Información incorrecta',
  no_respondio: 'No respondió lo que se preguntó',
  tono: 'Tono',
  promesa_riesgosa: 'Promesa riesgosa',
  oportunidad_perdida: 'Oportunidad perdida',
  otro: 'Otro',
};

export const RESOLVED_LABELS = { yes: 'Resuelto', no: 'Sin resolver', unknown: 'No se sabe' } as const;

/** Rangos del filtro de semanas. */
export const WEEK_RANGES = [4, 8, 12, 26] as const;
export type WeekRange = (typeof WEEK_RANGES)[number];

/** Segundos en horario de atención, legibles: "menos de 1 min", "12 min", "2 h 05 min". */
export function durationLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return 'menos de 1 min';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** "Semana del 5/10". */
export function weekLabel(weekStart: string, long = false): string {
  const date = new Date(`${weekStart}T12:00:00Z`);
  const text = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(
    date,
  );
  return long ? `Semana del ${text}` : text;
}

export function percentLabel(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '—'
    : `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(value)} %`;
}

export function scoreLabel(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '—'
    : new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

export interface Delta {
  /** Texto con signo, para leer sin color: "+3", "−2", "igual". */
  text: string;
  direction: 'up' | 'down' | 'same' | 'none';
  /** Si subir es bueno (atendidas) o malo (sin respuesta, tiempo de respuesta). */
  good: boolean | null;
}

/** Variación contra la semana anterior. higherIsBetter: false para lo que conviene que baje. */
export function delta(
  current: number | null | undefined,
  previous: number | null | undefined,
  higherIsBetter: boolean,
  format: (value: number) => string = (value) => String(value),
): Delta {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return { text: '', direction: 'none', good: null };
  }
  const diff = current - previous;
  if (diff === 0) return { text: 'igual', direction: 'same', good: null };
  const sign = diff > 0 ? '+' : '−';
  return {
    text: `${sign}${format(Math.abs(diff))}`,
    direction: diff > 0 ? 'up' : 'down',
    good: diff > 0 === higherIsBetter,
  };
}

export interface Segment {
  text: string;
  mark: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parte un mensaje en tramos para resaltar las citas (se pintan con <mark> por interpolación, nunca con
 * innerHTML). El servidor validó cada cita con los espacios normalizados: acá un espacio de la cita
 * coincide con cualquier secuencia de espacios o saltos del mensaje.
 */
export function highlightSegments(text: string, quotes: readonly string[]): Segment[] {
  const ranges: [number, number][] = [];
  for (const quote of quotes) {
    const words = quote.normalize('NFC').trim().split(/\s+/u).filter(Boolean);
    if (words.length === 0) continue;
    const pattern = new RegExp(words.map(escapeRegExp).join('\\s+'), 'gu');
    for (const match of text.normalize('NFC').matchAll(pattern)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  if (ranges.length === 0) return [{ text, mark: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const source = text.normalize('NFC');
  const segments: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: source.slice(cursor, start), mark: false });
    segments.push({ text: source.slice(start, end), mark: true });
    cursor = end;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), mark: false });
  return segments;
}
