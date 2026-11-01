// Contrato del stream de tiempo real (tarea 025): GET /api/events (SSE). No es un endpoint JSON, así que
// no va en la lista de rutas JSON: scripts/openapi.ts lo registra aparte, para que el panel use los tipos
// generados de sus mensajes.
//
// Mensajes del stream:
//   event: ready   data: {}                  conectado (el panel vuelve a consultar si era una reconexión)
//   data: <InboxEvent>                       algo cambió: el panel pide el detalle a los endpoints de siempre
//   event: resync  data: {}                  el servidor pudo perder avisos: volver a consultar todo
//   event: end     data: <StreamEnd>         el servidor cierra el stream (no reconectar si es por la sesión)
//   : ping                                   latido (comentario SSE)
import { z } from 'zod';

const uuid = z.uuid();

// Cada variante con su id: así el cliente generado tiene un tipo por variante (InboxEvent = una de las dos).
export const conversationEventSchema = z
  .object({
    type: z.enum(['message.created', 'message.updated', 'conversation.updated', 'conversation.read']),
    conversationId: uuid,
  })
  .meta({ id: 'ConversationEvent' });
export const channelEventSchema = z
  .object({ type: z.literal('channel.updated'), channelId: uuid })
  .meta({ id: 'ChannelEvent' });
export const inboxEventSchema = z.union([conversationEventSchema, channelEventSchema]);
export type InboxEvent = z.infer<typeof inboxEventSchema>;

export const STREAM_END_REASONS = ['unauthenticated', 'forbidden', 'tenant_changed', 'restart'] as const;
export type StreamEndReason = (typeof STREAM_END_REASONS)[number];

export const streamEndSchema = z.object({ reason: z.enum(STREAM_END_REASONS) }).meta({ id: 'StreamEnd' });

/** Para el OpenAPI (scripts/openapi.ts): el endpoint con los mensajes que puede mandar. */
export const eventsRoute = {
  path: '/events',
  operationId: 'streamEvents',
  summary: 'Stream SSE de cambios de la bandeja (solo tipos e identificadores; 429 con demasiados streams)',
  message: z.union([inboxEventSchema, streamEndSchema]),
};
