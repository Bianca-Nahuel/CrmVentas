// Contratos HTTP de la bandeja (tarea 014): de acá salen la validación (ZodValidationPipe) y el documento
// OpenAPI (scripts/openapi.ts), del que el panel genera su cliente. .meta({ id }) le pone nombre al
// esquema en el documento.
import { z } from 'zod';
import type { ApiRoute } from '../http/api-route.js';

const uuid = z.uuid();
const isoDate = z.iso.datetime({ offset: true });

// Sin id: siempre se usa con .nullable() (sin calificar) y así el documento lo dice en cada campo.
export const leadTierSchema = z.enum(['hot', 'warm', 'cold']);
export const leadStateSchema = z.enum(['open', 'handed_off', 'ai_paused']).meta({ id: 'LeadState' });
const messageTypeSchema = z
  .enum(['text', 'image', 'audio', 'video', 'document', 'location', 'other'])
  .meta({ id: 'MessageType' });
const senderTypeSchema = z.enum(['contact', 'ai', 'user', 'app']).meta({ id: 'SenderType' });

const TIER_FILTER = /^(hot|warm|cold|none)(,(hot|warm|cold|none)){0,3}$/;
export const LEADS_MAX_PAGE_SIZE = 50;

export const leadListQuerySchema = z
  .object({
    // Varios niveles separados por coma; "none" = sin calificar.
    tier: z.string().regex(TIER_FILTER).optional(),
    status: leadStateSchema.optional(),
    channelId: uuid.optional(),
    // Nombre, o número si solo tiene dígitos y separadores (se comparan solo los dígitos).
    q: z.string().trim().min(2).max(100).optional(),
    // unanswered: el cliente espera respuesta; unread: tiene mensajes que este usuario no vio.
    attention: z.enum(['unanswered', 'unread']).optional(),
    // priority (bandeja): primero las que esperan a una persona; después calor y espera por igual.
    sort: z.enum(['default', 'priority', 'score', 'last_message']).default('default'),
    dir: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(0).max(10_000).default(0),
    pageSize: z.coerce.number().int().min(1).max(LEADS_MAX_PAGE_SIZE).default(25),
  })
  .strict();
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

const channelRefSchema = z
  .object({ id: uuid, name: z.string(), phoneNumber: z.string() })
  .meta({ id: 'ChannelRef' });
const contactRefSchema = z
  .object({
    // display_name o profile_name; null si WhatsApp no trajo ninguno.
    name: z.string().nullable(),
    waId: z.string(),
  })
  .meta({ id: 'ContactRef' });

export const leadRowSchema = z
  .object({
    id: uuid,
    contact: contactRefSchema,
    channel: channelRefSchema,
    score: z.number().int().nullable(),
    tier: leadTierSchema.nullable(),
    state: leadStateSchema,
    // Derivada y sin respuesta de una persona del equipo desde la derivación.
    pendingHandoff: z.boolean(),
    // El último mensaje del cliente no tiene respuesta (de la IA o de una persona) y desde cuándo espera.
    awaitingReply: z.boolean(),
    waitingSince: isoDate.nullable(),
    // Hay mensajes del cliente que este usuario todavía no vio.
    unread: z.boolean(),
    lastMessage: z
      .object({
        type: messageTypeSchema,
        senderType: senderTypeSchema,
        // Texto del cliente o del equipo, cortado en el servidor. Contenido no confiable: se muestra como texto.
        preview: z.string().nullable(),
        sentAt: isoDate,
      })
      .nullable(),
    lastMessageAt: isoDate,
  })
  .meta({ id: 'LeadRow' });
export type LeadRow = z.infer<typeof leadRowSchema>;

export const leadListSchema = z
  .object({
    items: z.array(leadRowSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    // Seller sin números asignados: la lista vacía tiene una explicación.
    noChannels: z.boolean(),
  })
  .meta({ id: 'LeadList' });
export type LeadList = z.infer<typeof leadListSchema>;

export const leadSummarySchema = z
  .object({
    pendingHandoffs: z.number().int(),
    // Números que el usuario puede ver (opciones del filtro "Número"; vacío para el seller sin números).
    channels: z.array(channelRefSchema),
  })
  .meta({ id: 'LeadSummary' });

export const conversationParamsSchema = z.object({ id: uuid }).strict();

// Por qué no se puede responder (reglas de envío de messaging/outbound, sin 'superseded').
export const replyBlockedReasonSchema = z
  .enum(['no_inbound', 'window_expired', 'contact_blocked', 'channel_unavailable', 'channel_paused'])
  .meta({ id: 'ReplyBlockedReason' });
export type ReplyBlockedReason = z.infer<typeof replyBlockedReasonSchema>;

export const conversationDetailSchema = z
  .object({
    id: uuid,
    contact: contactRefSchema,
    channel: channelRefSchema,
    score: z.number().int().nullable(),
    tier: leadTierSchema.nullable(),
    scoreBreakdown: z
      .object({
        dimensions: z.array(
          z.object({ key: z.string(), signal: z.number(), weight: z.number(), points: z.number() }),
        ),
        completeness: z
          .object({
            value: z.number(),
            weight: z.number(),
            obtained: z.array(z.string()),
            missing: z.array(z.string()),
          })
          .nullable(),
      })
      .nullable()
      .meta({ id: 'ScoreBreakdown' }),
    // Datos obtenidos por la IA, con la etiqueta de la config de la empresa (null si el campo ya no existe).
    extractedData: z.array(z.object({ key: z.string(), label: z.string().nullable(), value: z.string() })),
    handoff: z
      .object({
        at: isoDate,
        reason: z.string(),
        // Generado por la IA con texto del cliente: el panel lo muestra como "no verificado".
        summary: z.string().nullable(),
      })
      .nullable(),
    ai: z.object({
      state: z.enum(['active', 'handed_off', 'paused']),
      pausedUntil: isoDate.nullable(),
      lastReactivation: z.object({ at: isoDate, byName: z.string().nullable() }).nullable(),
    }),
    // Si se puede responder desde el panel y, si no, por qué (las mismas reglas que el envío).
    reply: z
      .object({
        allowed: z.boolean(),
        reason: replyBlockedReasonSchema.nullable(),
        // Hasta cuándo están pausados los envíos del número; null si no vence (riesgo de bloqueo).
        pausedUntil: isoDate.nullable(),
      })
      .meta({ id: 'ReplyAvailability' }),
    lastMessageAt: isoDate,
  })
  .meta({ id: 'ConversationDetail' });
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const MESSAGES_MAX_LIMIT = 100;
export const messageListQuerySchema = z
  .object({
    // Cursor opaco de la página anterior (nextBefore).
    before: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MESSAGES_MAX_LIMIT).default(50),
  })
  .strict();

export const messageSchema = z
  .object({
    id: uuid,
    direction: z.enum(['inbound', 'outbound']),
    senderType: senderTypeSchema,
    // Nombre de la persona del equipo que lo mandó (sender_type = user).
    sentByName: z.string().nullable(),
    type: messageTypeSchema,
    // Texto tal cual llegó o salió: contenido no confiable, se muestra como texto.
    body: z.string().nullable(),
    // Solo los salientes (null en los entrantes). Sale del outbox mientras no se envió y de los acuses
    // después. reason: en 'failed', not_sent o maybe_sent (pudo haber salido); en 'rejected', la regla de
    // envío. Nunca el error del proveedor.
    delivery: z
      .object({
        state: z.enum(['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'rejected']),
        reason: z.enum(['not_sent', 'maybe_sent']).or(replyBlockedReasonSchema).nullable(),
      })
      .nullable()
      .meta({ id: 'Delivery' }),
    // Cuándo salió (o cuándo se encoló, si todavía no salió).
    sentAt: isoDate,
  })
  .meta({ id: 'Message' });
export type MessageDto = z.infer<typeof messageSchema>;

/** 4096: tope de un mensaje de texto de WhatsApp (en caracteres, como char_length en la base). */
const REPLY_MAX_CHARS = 4096;
export const sendMessageBodySchema = z
  .object({
    // Sin los espacios del principio y del final; los saltos de línea del medio se conservan.
    body: z
      .string()
      .trim()
      .min(1)
      .refine((text) => [...text].length <= REPLY_MAX_CHARS, `hasta ${REPLY_MAX_CHARS} caracteres`),
    // La genera el panel una vez por envío y la repite en los reintentos: no se manda dos veces.
    idempotencyKey: uuid,
  })
  .strict()
  .meta({ id: 'SendMessageBody' });
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

export const messageListSchema = z
  .object({
    // Del más viejo al más nuevo.
    items: z.array(messageSchema),
    // Para pedir los anteriores; null si no hay más.
    nextBefore: z.string().nullable(),
  })
  .meta({ id: 'MessageList' });

export const inboxRoutes: ApiRoute[] = [
  {
    method: 'get',
    path: '/leads',
    operationId: 'listLeads',
    summary: 'Grilla de leads (conversaciones visibles para el usuario)',
    query: leadListQuerySchema,
    response: leadListSchema,
  },
  {
    method: 'get',
    path: '/leads/summary',
    operationId: 'getLeadSummary',
    summary: 'Cantidad de derivadas sin atender',
    response: leadSummarySchema,
  },
  {
    method: 'get',
    path: '/conversations/{id}',
    operationId: 'getConversation',
    summary: 'Detalle de una conversación',
    params: conversationParamsSchema,
    response: conversationDetailSchema,
  },
  {
    method: 'get',
    path: '/conversations/{id}/messages',
    operationId: 'listMessages',
    summary: 'Mensajes, paginados hacia atrás',
    params: conversationParamsSchema,
    query: messageListQuerySchema,
    response: messageListSchema,
  },
  {
    method: 'post',
    path: '/conversations/{id}/messages',
    operationId: 'sendMessage',
    summary:
      'Responde por WhatsApp desde el panel (idempotente por idempotencyKey). 409 con code si no se puede enviar',
    params: conversationParamsSchema,
    body: sendMessageBodySchema,
    response: messageSchema,
    conflict: true,
  },
  {
    method: 'post',
    path: '/conversations/{id}/read',
    operationId: 'markConversationRead',
    summary: 'Marca la conversación como vista por el usuario',
    params: conversationParamsSchema,
  },
  {
    method: 'post',
    path: '/conversations/{id}/reactivate-ai',
    operationId: 'reactivateAi',
    summary: 'Vuelve a activar la IA en una conversación derivada o pausada (idempotente)',
    params: conversationParamsSchema,
    response: conversationDetailSchema,
  },
];
