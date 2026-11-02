// Horario de atención en la zona horaria de la empresa (tenants.timezone). Sin dependencias: Intl.
import type { WeeklyHours } from '@ventas/shared';

const DAY_KEYS = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
} as const;
const DAY_NAMES_ES = {
  mon: 'lunes',
  tue: 'martes',
  wed: 'miércoles',
  thu: 'jueves',
  fri: 'viernes',
  sat: 'sábado',
  sun: 'domingo',
} as const;

export interface LocalTime {
  /** AAAA-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
  day: keyof typeof DAY_NAMES_ES;
  dayName: string;
}

export function localTime(at: Date, timezone: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const day = DAY_KEYS[parts.weekday as keyof typeof DAY_KEYS];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    day,
    dayName: DAY_NAMES_ES[day],
  };
}

export function isOpenAt(hours: WeeklyHours, timezone: string, at: Date): boolean {
  const local = localTime(at, timezone);
  return hours[local.day].some((range) => range.open <= local.time && local.time < range.close);
}

const WEEKDAY_BY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
/** Tope de días que recorre businessSecondsBetween (10 años): un intervalo más largo es un dato roto. */
const MAX_DAYS = 3_660;

/** Diferencia (ms) entre la hora local de la zona y UTC en ese instante. */
function zoneOffsetMs(at: number, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, Number(part.value)]),
  );
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Instante de una hora local (día como medianoche UTC del calendario local + minutos). */
function zonedInstant(dayUtc: number, minutes: number, timezone: string): number {
  const wall = dayUtc + minutes * 60_000;
  const guess = wall - zoneOffsetMs(wall, timezone);
  // Si entre la hora supuesta y la real hay un cambio de horario, el offset correcto es el del resultado.
  return wall - zoneOffsetMs(guess, timezone);
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Segundos entre from y to que caen dentro del horario de atención (service_hours, en la zona de la
 * empresa). Un mensaje del viernes 20 h respondido el lunes 9:10 (abre a las 9) cuenta 600.
 * - null si la semana no tiene ninguna franja: no hay horario contra el cual medir;
 * - 0 si to <= from;
 * - una franja que cierra a las 23:59 (el máximo que acepta la config) se cuenta hasta la medianoche;
 * - no hay calendario de feriados: un feriado cuenta como un día más.
 */
export function businessSecondsBetween(
  from: Date,
  to: Date,
  hours: WeeklyHours,
  timezone: string,
): number | null {
  if (Object.values(hours).every((ranges) => ranges.length === 0)) return null;
  const start = from.getTime();
  const end = to.getTime();
  if (end <= start) return 0;

  const first = localTime(from, timezone).date;
  const last = localTime(to, timezone).date;
  let day = Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, Number(first.slice(8, 10)));
  const lastDay = Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)) - 1, Number(last.slice(8, 10)));
  let totalMs = 0;
  for (let count = 0; day <= lastDay && count < MAX_DAYS; count++, day += 86_400_000) {
    const ranges = hours[WEEKDAY_BY_INDEX[new Date(day).getUTCDay()]!];
    for (const range of ranges) {
      const close = range.close === '23:59' ? 24 * 60 : minutesOf(range.close);
      const opensAt = zonedInstant(day, minutesOf(range.open), timezone);
      const closesAt = zonedInstant(day, close, timezone);
      const overlap = Math.min(end, closesAt) - Math.max(start, opensAt);
      if (overlap > 0) totalMs += overlap;
    }
  }
  return Math.floor(totalMs / 1000);
}
