import { Ban, CircleCheck, Clock, Unplug, type IconNode } from 'lucide';
import type { ChannelWithMembers } from '../../api/generated';

export interface ChannelStatusView {
  label: string;
  icon: IconNode;
  pill: string;
}

/** Estado de un canal: siempre ícono y texto, nunca solo color. */
export function channelStatus(channel: ChannelWithMembers): ChannelStatusView {
  switch (channel.status) {
    case 'connected':
      return { label: 'Conectado', icon: CircleCheck, pill: 'bg-success-soft text-success' };
    case 'pending':
      return {
        // Con número: la sesión se está levantando de nuevo (por ejemplo, después de reiniciar el servidor).
        label: channel.phoneNumber ? 'Reconectando' : 'Esperando el escaneo',
        icon: Clock,
        pill: 'bg-warning-soft text-warning',
      };
    case 'disconnected':
      return { label: 'Desconectado', icon: Unplug, pill: 'bg-surface-2 text-muted' };
    case 'banned':
      return { label: 'Bloqueado por WhatsApp', icon: Ban, pill: 'bg-error-soft text-error' };
  }
}

/**
 * Por qué se desconectó, en palabras del usuario. null si está conectado o esperando. Lo usan la lista y el
 * diálogo del QR (un escaneo rechazado).
 */
export function disconnectExplanation(
  channel: Pick<ChannelWithMembers, 'status' | 'phoneNumber' | 'disconnectReason' | 'numberInUse'>,
): string | null {
  if (channel.status === 'banned')
    return 'WhatsApp bloqueó este número. No se puede reconectar desde el panel.';
  if (channel.status !== 'disconnected') return null;
  switch (channel.disconnectReason) {
    case 'logged_out':
      return 'Lo desconectó una persona del equipo.';
    case 'phone_mismatch':
      return `Se escaneó el QR con otro teléfono. Para reconectarlo, escanealo con el teléfono de ${channel.phoneNumber}.`;
    case 'number_in_use':
      return channel.numberInUse?.scope === 'same_tenant' && channel.numberInUse.channelName
        ? `Ese número ya está conectado en el canal «${channel.numberInUse.channelName}».`
        : 'Ese número ya está conectado en otra cuenta. Escribinos para revisarlo.';
    case 'pairing_expired':
      return 'El QR venció antes de que lo escanearan.';
    case 'session_failed':
      return 'WhatsApp cerró la sesión. Volvé a vincular el número.';
    default:
      return 'Se perdió la conexión con WhatsApp.';
  }
}

/** Fecha corta en español: "1 nov, 10:32". */
export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Nunca se conectó: se puede cancelar (borrar) en vez de desconectar. */
export function neverConnected(channel: ChannelWithMembers): boolean {
  return channel.phoneNumber === null && channel.connectedAt === null && channel.status !== 'connected';
}

/** Iniciales para el avatar: primera letra de las dos primeras palabras del nombre. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toLocaleUpperCase('es-AR'))
    .join('');
}
