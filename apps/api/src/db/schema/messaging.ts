// Tablas de mensajería: canales de WhatsApp, contactos, conversaciones y mensajes (tarea 003).
//
// Consistencia entre empresas: channels, contacts y conversations exponen UNIQUE (tenant_id, id) y las
// referencias entre ellas son FKs compuestas que incluyen tenant_id, así una conversación no puede
// mezclar el canal de una empresa con el contacto de otra (lo frena la base, no solo el código).
// messages apunta a (tenant_id, conversation_id, channel_id) para que el canal del mensaje sea el de
// su conversación.
//
// Las FKs a usuarios de default_user_id, assigned_user_id y sent_by_user_id van a memberships
// (tenant_id, user_id) con ON DELETE SET NULL (columna), que Drizzle no sabe escribir: están en la
// migración 0003, junto con triggers, permisos, RLS y resolve_channel().
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, users } from './auth.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const channels = pgTable(
  'channels',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    phoneNumber: text('phone_number').notNull(),
    provider: text('provider').notNull(),
    connectionType: text('connection_type').notNull(),
    // Sesión de WAHA o phone_number_id de Meta. Lo usa resolve_channel() para el webhook.
    externalId: text('external_id'),
    status: text('status').notNull().default('pending'),
    defaultUserId: uuid('default_user_id'),
    riskAcceptedAt: timestamp('risk_accepted_at', { withTimezone: true }),
    // RESTRICT y no SET NULL: el CHECK de riesgo exige quién lo aceptó mientras el canal exista.
    riskAcceptedBy: uuid('risk_accepted_by').references(() => users.id, { onDelete: 'restrict' }),
    // Sin secretos: los tokens de cada canal no van en esta tabla.
    providerConfig: jsonb('provider_config').notNull().default({}),
    // Envíos frenados (riesgo de bloqueo): 'infinity' hasta que alguien lo levante a mano. El motivo es
    // un código (blocked_risk:463), sin datos personales.
    sendingPausedUntil: timestamp('sending_paused_until', { withTimezone: true }),
    sendingPausedReason: text('sending_paused_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('channels_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('channels_tenant_phone_unique').on(t.tenantId, t.phoneNumber),
    unique('channels_provider_external_id_unique').on(t.provider, t.externalId),
    check('channels_phone_e164_check', sql`${t.phoneNumber} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check('channels_provider_check', sql`${t.provider} IN ('waha', 'cloud_api')`),
    check('channels_connection_type_check', sql`${t.connectionType} IN ('official', 'unofficial')`),
    check('channels_status_check', sql`${t.status} IN ('pending', 'connected', 'disconnected', 'banned')`),
    check(
      'channels_provider_connection_check',
      sql`(${t.provider} = 'waha' AND ${t.connectionType} = 'unofficial') OR (${t.provider} = 'cloud_api' AND ${t.connectionType} = 'official')`,
    ),
    check(
      'channels_risk_accepted_check',
      sql`${t.connectionType} <> 'unofficial' OR (${t.riskAcceptedAt} IS NOT NULL AND ${t.riskAcceptedBy} IS NOT NULL)`,
    ),
    check('channels_provider_config_object_check', sql`jsonb_typeof(${t.providerConfig}) = 'object'`),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    tenantId: tenantId(),
    // Sin CHECK de E.164: WhatsApp también identifica contactos con un LID (sin teléfono); se define en la 004.
    waId: text('wa_id').notNull(),
    profileName: text('profile_name'),
    displayName: text('display_name'),
    marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
    optInAt: timestamp('opt_in_at', { withTimezone: true }),
    blocked: boolean('blocked').notNull().default(false),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('contacts_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('contacts_tenant_wa_id_unique').on(t.tenantId, t.waId),
    check('contacts_opt_in_check', sql`NOT ${t.marketingOptIn} OR ${t.optInAt} IS NOT NULL`),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    tenantId: tenantId(),
    channelId: uuid('channel_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    status: text('status').notNull().default('open'),
    inbox: text('inbox').notNull().default('sales'),
    assignedUserId: uuid('assigned_user_id'),
    // Si está vigente, la IA no responde (un humano tomó la conversación).
    aiPausedUntil: timestamp('ai_paused_until', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull(),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    // Agente (tarea 006): puntaje y calificación. Las escribe solo el worker de la IA.
    leadScore: smallint('lead_score'),
    leadScorePeak: smallint('lead_score_peak'),
    leadScoreAt: timestamp('lead_score_at', { withTimezone: true }),
    scoreBreakdown: jsonb('score_breakdown'),
    // hot | warm | cold, derivado de los umbrales de la config: solo para mostrar y ordenar.
    leadTier: text('lead_tier'),
    // Mensajes que mandó la IA (respuestas y preguntas de un disparador), y cuántos con el lead caliente.
    qualificationTurns: integer('qualification_turns').notNull().default(0),
    hotTurns: integer('hot_turns').notNull().default(0),
    suggestionsCount: integer('suggestions_count').notNull().default(0),
    // Campos de calificación obtenidos (se combinan, nunca se borran) y lo descubierto por la guía.
    extractedData: jsonb('extracted_data').notNull().default({}),
    discoveredNotes: jsonb('discovered_notes').notNull().default([]),
    // Derivada a una persona: desde acá la IA no vuelve a escribir (salvo el texto fijo, una vez).
    handedOffAt: timestamp('handed_off_at', { withTimezone: true }),
    handoffReason: text('handoff_reason'),
    handoffSummary: text('handoff_summary'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Destino de la FK de messages (incluye channel_id para atar el mensaje al canal de la conversación).
    unique('conversations_tenant_id_channel_unique').on(t.tenantId, t.id, t.channelId),
    foreignKey({
      name: 'conversations_channel_fk',
      columns: [t.tenantId, t.channelId],
      foreignColumns: [channels.tenantId, channels.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversations_contact_fk',
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contacts.tenantId, contacts.id],
    }).onDelete('cascade'),
    uniqueIndex('conversations_open_unique')
      .on(t.channelId, t.contactId)
      .where(sql`${t.status} = 'open'`),
    index('conversations_tenant_last_message_idx').on(t.tenantId, t.lastMessageAt.desc()),
    index('conversations_tenant_assigned_idx').on(t.tenantId, t.assignedUserId),
    // Para las cascadas y el historial (el UNIQUE parcial solo cubre las abiertas).
    index('conversations_tenant_channel_idx').on(t.tenantId, t.channelId),
    index('conversations_tenant_contact_idx').on(t.tenantId, t.contactId),
    check('conversations_status_check', sql`${t.status} IN ('open', 'closed', 'archived')`),
    check('conversations_inbox_check', sql`${t.inbox} IN ('sales', 'other')`),
    check('conversations_lead_score_check', sql`${t.leadScore} BETWEEN 0 AND 100`),
    check('conversations_lead_score_peak_check', sql`${t.leadScorePeak} BETWEEN 0 AND 100`),
    check('conversations_lead_tier_check', sql`${t.leadTier} IN ('hot', 'warm', 'cold')`),
    check(
      'conversations_turns_check',
      sql`${t.qualificationTurns} >= 0 AND ${t.hotTurns} >= 0 AND ${t.suggestionsCount} >= 0`,
    ),
    check('conversations_extracted_data_check', sql`jsonb_typeof(${t.extractedData}) = 'object'`),
    check('conversations_discovered_notes_check', sql`jsonb_typeof(${t.discoveredNotes}) = 'array'`),
    check('conversations_handoff_reason_check', sql`${t.handoffReason} ~ '^[a-z0-9_:]{1,80}$'`),
    check('conversations_handoff_summary_check', sql`char_length(${t.handoffSummary}) <= 2000`),
    check('conversations_handoff_check', sql`(${t.handedOffAt} IS NULL) = (${t.handoffReason} IS NULL)`),
  ],
);

// Sin updated_at: los mensajes no se editan salvo status y cost_usd (grants por columna en la 0003).
export const messages = pgTable(
  'messages',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    externalId: text('external_id').notNull(),
    direction: text('direction').notNull(),
    senderType: text('sender_type').notNull(),
    sentByUserId: uuid('sent_by_user_id'),
    type: text('type').notNull(),
    body: text('body'),
    // Key del archivo en R2.
    mediaKey: text('media_key'),
    status: text('status'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 5 }),
    // Payload crudo del proveedor.
    raw: jsonb('raw').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Idempotencia del webhook: INSERT ... ON CONFLICT (channel_id, external_id) DO NOTHING.
    unique('messages_channel_external_id_unique').on(t.channelId, t.externalId),
    // Destino de la FK de outbound_messages.message_id (el mensaje es de la misma conversación).
    unique('messages_tenant_id_conversation_unique').on(t.tenantId, t.id, t.conversationId),
    foreignKey({
      name: 'messages_conversation_fk',
      columns: [t.tenantId, t.conversationId, t.channelId],
      foreignColumns: [conversations.tenantId, conversations.id, conversations.channelId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'messages_channel_fk',
      columns: [t.tenantId, t.channelId],
      foreignColumns: [channels.tenantId, channels.id],
    }).onDelete('cascade'),
    index('messages_conversation_sent_at_idx').on(t.conversationId, t.sentAt),
    check('messages_direction_check', sql`${t.direction} IN ('inbound', 'outbound')`),
    check('messages_sender_type_check', sql`${t.senderType} IN ('contact', 'ai', 'user', 'app')`),
    check(
      'messages_type_check',
      sql`${t.type} IN ('text', 'image', 'audio', 'video', 'document', 'location', 'other')`,
    ),
    check('messages_status_check', sql`${t.status} IN ('received', 'sent', 'delivered', 'read', 'failed')`),
    // Entrante ⇔ lo mandó el contacto.
    check(
      'messages_direction_sender_check',
      sql`(${t.direction} = 'inbound') = (${t.senderType} = 'contact')`,
    ),
  ],
);

// Outbox de envíos (tarea 005): la intención de mandar un mensaje, con sus intentos. messages guarda lo
// que de verdad pasó por WhatsApp; la fila de acá se enlaza con message_id cuando el envío sale.
// Sin DELETE y con UPDATE solo de las columnas de estado (grants en la 0007).
export const outboundMessages = pgTable(
  'outbound_messages',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    // Clave del que pide el envío: repetirla no crea otro (UNIQUE por empresa).
    idempotencyKey: text('idempotency_key').notNull(),
    senderType: text('sender_type').notNull(),
    sentByUserId: uuid('sent_by_user_id'),
    body: text('body').notNull(),
    status: text('status').notNull().default('queued'),
    rejectReason: text('reject_reason'),
    attempts: integer('attempts').notNull().default(0),
    // Código de error (SendErrorKind), nunca el mensaje del proveedor.
    lastError: text('last_error'),
    // Momento del último claim (queued → sending): límite por minuto, separación por chat y envíos trabados.
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    externalId: text('external_id'),
    messageId: uuid('message_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('outbound_messages_tenant_idempotency_unique').on(t.tenantId, t.idempotencyKey),
    // Destino de la FK de ai_runs.outbound_message_id (tarea 006).
    unique('outbound_messages_tenant_id_id_unique').on(t.tenantId, t.id),
    // El canal tiene que ser el de la conversación (misma FK compuesta que messages).
    foreignKey({
      name: 'outbound_messages_conversation_fk',
      columns: [t.tenantId, t.conversationId, t.channelId],
      foreignColumns: [conversations.tenantId, conversations.id, conversations.channelId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'outbound_messages_channel_fk',
      columns: [t.tenantId, t.channelId],
      foreignColumns: [channels.tenantId, channels.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'outbound_messages_message_fk',
      columns: [t.tenantId, t.messageId, t.conversationId],
      foreignColumns: [messages.tenantId, messages.id, messages.conversationId],
    }).onDelete('cascade'),
    // Ecos: ¿este id ya es nuestro?
    uniqueIndex('outbound_messages_channel_external_id_unique')
      .on(t.channelId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index('outbound_messages_channel_claimed_idx').on(t.channelId, t.claimedAt),
    index('outbound_messages_conversation_claimed_idx').on(t.conversationId, t.claimedAt),
    index('outbound_messages_conversation_sending_idx')
      .on(t.conversationId)
      .where(sql`${t.status} = 'sending'`),
    check('outbound_messages_sender_type_check', sql`${t.senderType} IN ('ai', 'user', 'app')`),
    check(
      'outbound_messages_status_check',
      sql`${t.status} IN ('queued', 'sending', 'sent', 'failed', 'rejected')`,
    ),
    check(
      'outbound_messages_reject_reason_check',
      sql`${t.rejectReason} IN ('no_inbound', 'window_expired', 'contact_blocked', 'channel_unavailable', 'channel_paused', 'superseded')`,
    ),
    check(
      'outbound_messages_rejected_reason_check',
      sql`(${t.status} = 'rejected') = (${t.rejectReason} IS NOT NULL)`,
    ),
    check(
      'outbound_messages_last_error_check',
      sql`${t.lastError} IN ('transient', 'rate_limited', 'session_down', 'blocked_risk', 'invalid_recipient', 'unknown_outcome')`,
    ),
    check(
      'outbound_messages_sent_external_id_check',
      sql`${t.status} <> 'sent' OR ${t.externalId} IS NOT NULL`,
    ),
    // 4096: tope de un mensaje de texto de WhatsApp.
    check('outbound_messages_body_length_check', sql`char_length(${t.body}) BETWEEN 1 AND 4096`),
    check('outbound_messages_idempotency_key_check', sql`char_length(${t.idempotencyKey}) BETWEEN 1 AND 200`),
    check('outbound_messages_attempts_check', sql`${t.attempts} >= 0`),
  ],
);

export const messagingSchema = { channels, contacts, conversations, messages, outboundMessages };

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type OutboundMessage = typeof outboundMessages.$inferSelect;
