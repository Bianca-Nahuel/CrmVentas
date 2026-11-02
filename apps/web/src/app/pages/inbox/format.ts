// Textos y fechas de la bandeja. Funciones puras (se prueban sin TestBed). Locale es-AR.
import type {
  Delivery,
  LeadState,
  MessageType,
  ReplyBlockedReason as ReplyBlockedReasonOrNull,
  SenderType,
  StoredCloseOutcome,
} from '../../api/generated';

/** Motivo por el que no se puede responder (el tipo generado incluye null). */
export type ReplyBlockedReason = NonNullable<ReplyBlockedReasonOrNull>;

const LOCALE = 'es-AR';

export const STATE_LABELS: Record<LeadState, string> = {
  open: 'Abierta',
  handed_off: 'Derivada',
  ai_paused: 'IA pausada',
};

/** Resultado del cierre (tarea 026). */
export const CLOSE_OUTCOME_LABELS: Record<StoredCloseOutcome, string> = {
  sold: 'Vendida',
  not_sold: 'No compró',
  no_response: 'El cliente no respondió',
  not_a_lead: 'No era un interesado',
  other: 'Otro',
  auto_inactive: 'Cerrada por inactividad',
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

/** Estado de un mensaje saliente, siempre en palabras (el ícono acompaña, nunca solo el color). */
export function deliveryLabel(delivery: NonNullable<Delivery>): string {
  switch (delivery.state) {
    case 'queued':
      return 'En cola';
    case 'sending':
      return 'Enviando…';
    case 'sent':
      return 'Enviado';
    case 'delivered':
      return 'Entregado';
    case 'read':
      return 'Leído';
    case 'failed':
      return delivery.reason === 'maybe_sent' ? 'No sabemos si llegó' : 'No se envió';
    case 'rejected':
      return 'No se envió';
  }
}

/** Ayuda debajo de un mensaje que no salió (o que no sabemos si salió). */
export function deliveryHelp(delivery: NonNullable<Delivery>): string | null {
  if (delivery.state === 'failed') {
    return delivery.reason === 'maybe_sent'
      ? 'Puede que haya llegado igual: revisalo en el teléfono antes de reenviarlo.'
      : null;
  }
  if (delivery.state === 'rejected' && delivery.reason) {
    return REPLY_BLOCKED_SHORT[delivery.reason as ReplyBlockedReason] ?? null;
  }
  return null;
}

/** Por qué no se puede responder desde el panel (aviso arriba de la caja de respuesta). */
export const REPLY_BLOCKED_TEXT: Record<ReplyBlockedReason, string> = {
  channel_paused:
    'Los envíos de este número están pausados por riesgo de bloqueo de WhatsApp. Mientras tanto, respondé desde el teléfono. Un administrador puede revisar el número.',
  channel_unavailable:
    'Este número está desconectado de WhatsApp. Hay que volver a vincularlo para responder desde acá.',
  window_expired:
    'Pasaron más de 24 h desde el último mensaje del cliente. WhatsApp solo deja responder dentro de ese plazo: cuando vuelva a escribir, vas a poder contestarle.',
  no_inbound: 'El cliente todavía no escribió. Desde el panel no se inician conversaciones.',
  contact_blocked: 'Este contacto está bloqueado.',
  conversation_closed:
    'La conversación está cerrada. Si el cliente vuelve a escribir, empieza una conversación nueva.',
};

const REPLY_BLOCKED_SHORT: Record<ReplyBlockedReason, string> = {
  channel_paused: 'Los envíos del número estaban pausados.',
  channel_unavailable: 'El número estaba desconectado.',
  window_expired: 'Pasaron más de 24 h desde el último mensaje del cliente.',
  no_inbound: 'El cliente todavía no había escrito.',
  contact_blocked: 'El contacto está bloqueado.',
  conversation_closed: 'La conversación estaba cerrada.',
};

/** Código del 409 de POST /conversations/:id/messages → motivo (los mismos de reply.reason). */
export const REPLY_CONFLICT_CODES: Record<string, ReplyBlockedReason> = {
  CHANNEL_PAUSED: 'channel_paused',
  CHANNEL_UNAVAILABLE: 'channel_unavailable',
  WINDOW_EXPIRED: 'window_expired',
  NO_INBOUND: 'no_inbound',
  CONTACT_BLOCKED: 'contact_blocked',
  CONVERSATION_CLOSED: 'conversation_closed',
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
