// Bandeja y leads (tarea 014): qué vendedores atienden cada número y eventos de la conversación.
//
// Las FKs a memberships (tenant_id, user_id), los permisos, la RLS y las políticas de visibilidad por
// número (RESTRICTIVE sobre conversations, messages, outbound_messages y ai_runs) están en la migración
// 0015, junto con app_sees_all_channels() y app_visible_channel_ids().
// app_sees_all_channels() lee el JSON crudo de la config vigente: confía en que toda versión pasó por
// TenantConfigService.insertVersion (que valida). contacts queda fuera de esa red (un contacto puede
// escribir a varios números): todo endpoint que liste contactos tiene que pasar por ConversationScope.
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';
import { channels, conversations } from './messaging.js';

// Asignación de números a vendedores (muchos a muchos). Un seller ve solo las conversaciones de sus
// números. Sin UPDATE: reemplazar la lista borra e inserta (0015).
export const channelMembers = pgTable(
  'channel_members',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => [
    primaryKey({ name: 'channel_members_pkey', columns: [t.channelId, t.userId] }),
    foreignKey({
      name: 'channel_members_channel_fk',
      columns: [t.tenantId, t.channelId],
      foreignColumns: [channels.tenantId, channels.id],
    }).onDelete('cascade'),
    index('channel_members_tenant_user_idx').on(t.tenantId, t.userId),
  ],
);

// Historial de la conversación que no es un mensaje: la reactivación de la IA (quién y cuándo, con el
// estado previo en data) y el cierre (tarea 026, con el resultado). Solo INSERT: es un registro.
export const conversationEvents = pgTable(
  'conversation_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    type: text('type').notNull(),
    userId: uuid('user_id'),
    // Sin texto del cliente: fechas, códigos y contadores.
    data: jsonb('data').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'conversation_events_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete('cascade'),
    index('conversation_events_conversation_idx').on(t.conversationId, t.type, t.createdAt.desc()),
    check('conversation_events_type_check', sql`${t.type} IN ('ai_reactivated', 'closed')`),
    check('conversation_events_data_check', sql`jsonb_typeof(${t.data}) = 'object'`),
  ],
);

// Hasta dónde vio cada persona del equipo cada conversación ("sin ver" en la bandeja). Una fila por
// (conversación, usuario); cada usuario solo ve y escribe las suyas (RLS en 0017).
export const conversationReads = pgTable(
  'conversation_reads',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id').notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'conversation_reads_pkey', columns: [t.conversationId, t.userId] }),
    foreignKey({
      name: 'conversation_reads_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete('cascade'),
  ],
);

export const inboxSchema = { channelMembers, conversationEvents, conversationReads };

export type ChannelMember = typeof channelMembers.$inferSelect;
export type ConversationEvent = typeof conversationEvents.$inferSelect;
