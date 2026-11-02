import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppTx } from '../db/tenant-context.js';

/**
 * Tiempo real (tarea 025). Los cambios se avisan con NOTIFY de Postgres en el canal `inbox_events`, desde
 * la MISMA transacción que guarda el cambio: Postgres entrega la notificación solo si la transacción hace
 * commit (y la descarta con un rollback), así que un aviso nunca apunta a datos que no existen.
 * Cada instancia de la API escucha el canal (RealtimeListener) y reparte a sus streams SSE (RealtimeHub).
 *
 * El aviso lleva SOLO identificadores y el tipo (nunca texto, nombres ni teléfonos): el panel vuelve a pedir
 * el detalle a los endpoints de la bandeja, que aplican la visibilidad. Así entra holgado en el límite de
 * 8000 bytes de NOTIFY.
 */
export const INBOX_EVENTS_CHANNEL = 'inbox_events';

const uuid = z.uuid();

export const CONVERSATION_EVENT_TYPES = [
  'message.created',
  'message.updated',
  'conversation.updated',
  'conversation.read',
] as const;
export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

/**
 * Lo que viaja por NOTIFY. Se valida al recibirlo: cualquier otra cosa en el canal se descarta.
 *   - conversation: cambió algo de una conversación (filtrado por empresa y número; `read` solo a su usuario).
 *   - channel: cambió el estado de un número (conexión, envíos pausados).
 *   - access: cambió quién ve qué en la empresa (asignaciones): se revalidan sus streams. No llega al panel.
 *   - user: el usuario cerró sesión, revocó sesiones o cambió de empresa: se revalidan sus streams.
 *   - session: se cerró o revocó una sesión puntual (por el hash del token, nunca el token).
 */
export const noticeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('conversation'),
    type: z.enum(CONVERSATION_EVENT_TYPES),
    tenantId: uuid,
    channelId: uuid,
    conversationId: uuid,
    userId: uuid.optional(),
  }),
  z.object({
    kind: z.literal('channel'),
    type: z.literal('channel.updated'),
    tenantId: uuid,
    channelId: uuid,
  }),
  z.object({ kind: z.literal('access'), tenantId: uuid }),
  z.object({ kind: z.literal('user'), userId: uuid }),
  z.object({ kind: z.literal('session'), sessionHash: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
export type Notice = z.infer<typeof noticeSchema>;

/** Hash con el que se identifica una sesión en los avisos (el token nunca sale de Better Auth). */
export function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Avisa un cambio. Va DENTRO de la transacción del cambio: se entrega recién con el commit. */
export async function publishNotice(tx: Pick<AppTx, 'execute'>, notice: Notice): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${INBOX_EVENTS_CHANNEL}, ${JSON.stringify(notice)})`);
}

/** Atajo para los cambios de una conversación. */
export function publishConversationEvent(
  tx: Pick<AppTx, 'execute'>,
  type: ConversationEventType,
  ids: { tenantId: string; channelId: string; conversationId: string; userId?: string },
): Promise<void> {
  return publishNotice(tx, { kind: 'conversation', type, ...ids });
}
