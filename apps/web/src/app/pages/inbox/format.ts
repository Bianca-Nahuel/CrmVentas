// Textos y fechas de la bandeja. Funciones puras (se prueban sin TestBed). Locale es-AR.
import type { LeadState, MessageType, SenderType } from '../../api/generated';

const LOCALE = 'es-AR';

export const STATE_LABELS: Record<LeadState, string> = {
  open: 'Abierta',
  handed_off: 'Derivada',
  ai_paused: 'IA pausada',
};

export const AI_STATE_LABELS: Record<'active' | 'handed_off' | 'paused', string> = {
  active: 'IA activa',
  handed_off: 'Derivada a una persona',
  paused: 'IA pausada',
};

export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  text: 'Mensaje',
  image: 'Imagen',
  audio: 'Audio',
  video: 'Video',
  document: 'Documento',
  location: 'Ubicación',
  other: 'Mensaje de un tipo no soportado',
};

export const SENDER_LABELS: Record<SenderType, string> = {
  contact: 'Cliente',
  ai: 'IA',
  user: 'Equipo',
  app: 'Mensaje automático',
};

// Motivos de derivación que decide el código (decide.ts y los disparadores de la config).
const REASONS: Record<string, string> = {
  asks_human: 'Pidió hablar con una persona',
  availability: 'Consultó disponibilidad o stock',
  payment_or_reservation: 'Quiere pagar o reservar',
  price_negotiation: 'Quiere negociar el precio',
  complaint: 'Hizo un reclamo',
  frustration: 'Se mostró molesto',
  cannot_answer: 'La IA no tenía la respuesta',
  qualified: 'Lead calificado',
  hot_turns: 'Lead caliente',
  max_turns: 'Se agotaron las preguntas de calificación',
  after_hours: 'Escribió fuera de horario',
  unsupported_media: 'Mandó audio o imagen',
  invalid_output: 'La IA no pudo responder',
};

/**
 * Motivo en palabras. Los códigos llevan sufijos (":incompleto", ":idioma") y los disparadores propios de
 * la empresa empiezan con "custom_"; lo desconocido se muestra como código, siempre como texto.
 */
export function reasonLabel(reason: string): string {
  const [base, detail] = reason.split(':');
  if (base === 'blocked') return 'Un control de seguridad frenó la respuesta';
  const label = REASONS[base!] ?? (base!.startsWith('custom_') ? 'Regla de la empresa' : reason);
  if (detail === 'incompleto') return `${label} (faltaban datos)`;
  if (detail === 'idioma') return `${label} (otro idioma)`;
  return label;
}

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** "Hoy", "Ayer" o "martes 27 de octubre" (con el año si no es el actual). */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return 'Hoy';
  if (dayKey(date) === dayKey(yesterday)) return 'Ayer';
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

export function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** Para listas: "recién", "hace 5 min", "14:30" (hoy), "ayer" o "27/10". */
export function shortWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return 'recién';
  if (minutes < 60) return `hace ${minutes} min`;
  const day = dayLabel(iso, now);
  if (day === 'Hoy') return timeLabel(iso);
  if (day === 'Ayer') return 'ayer';
  return new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit' }).format(date);
}

/** Fecha y hora completas para un title o un texto de ayuda. */
export function fullWhen(iso: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** Agrupa mensajes (ya ordenados del más viejo al más nuevo) por día local. */
export function groupByDay<T extends { sentAt: string }>(
  items: readonly T[],
  now = new Date(),
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const key = dayKey(new Date(item.sentAt));
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(item.sentAt, now), items: [item] });
  }
  return groups;
}

/** Nombre a mostrar de un contacto (WhatsApp puede no traer ninguno). */
export function contactName(contact: { name: string | null; waId: string }): string {
  return contact.name?.trim() || contact.waId;
}

/** Vista previa de un mensaje en la lista: el texto, o el tipo si no tiene texto. */
export function previewText(message: { type: MessageType; preview: string | null } | null): string {
  if (!message) return 'Sin mensajes';
  if (message.preview?.trim()) return message.preview;
  return MESSAGE_TYPE_LABELS[message.type];
}

/** Cuánto hace que el cliente espera respuesta: "recién", "12 min", "3 h", "2 d". */
export function waitingFor(iso: string, now = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'recién';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
