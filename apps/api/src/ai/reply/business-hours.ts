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
