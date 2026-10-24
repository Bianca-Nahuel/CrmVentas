import { Inject, Injectable } from '@nestjs/common';
import type { MessageReceivedEvent, SessionStatusEvent, WhatsAppEvent } from '@ventas/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { APP_DB, type AppDatabase } from '../../db/database.module.js';
import { channels, contacts, conversations, messages } from '../../db/schema/messaging.js';
import { withTenantTransaction, type AppTx } from '../../db/tenant-context.js';

export type InboundResult = 'guardado' | 'duplicado' | 'actualizado' | 'sin_cambios';

export interface ResolvedChannel {
  channelId: string;
  tenantId: string;
}

// Intentos de buscar-o-crear la conversación abierta si alguien la cierra justo en el medio.
const OPEN_CONVERSATION_ATTEMPTS = 3;

// Guarda un evento normalizado en la empresa dueña del canal. Todo pasa por la RLS de ventas_app:
// la empresa sale de resolve_channel() (por el external_id que generó el sistema), nunca del payload.
@Injectable()
export class InboundService {
  constructor(@Inject(APP_DB) private readonly database: AppDatabase) {}

  /**
   * Canal y empresa por el identificador del proveedor. null si no existe, está banned o la empresa no
   * está activa: el evento se descarta sin reintentar.
   * SECURITY DEFINER: no necesita contexto de empresa (todavía no se conoce).
   */
  async resolveChannel(event: WhatsAppEvent): Promise<ResolvedChannel | null> {
    const result = await this.database.db.execute<{ channel_id: string; tenant_id: string }>(
      sql`SELECT channel_id, tenant_id FROM resolve_channel(${event.provider}, ${event.channelExternalId})`,
    );
    const row = result.rows[0];
    return row ? { channelId: row.channel_id, tenantId: row.tenant_id } : null;
  }

  async process(event: WhatsAppEvent, channel: ResolvedChannel): Promise<InboundResult> {
    return withTenantTransaction(this.database.db, { tenantId: channel.tenantId }, (tx) =>
      event.type === 'message.received'
        ? this.saveMessage(tx, channel, event)
        : this.updateChannelStatus(tx, channel, event),
    );
  }

  private async saveMessage(
    tx: AppTx,
    channel: ResolvedChannel,
    event: MessageReceivedEvent,
  ): Promise<InboundResult> {
    // Un reenvío no toca el contacto ni abre una conversación nueva si la del mensaje ya se cerró.
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channel.channelId), eq(messages.externalId, event.externalMessageId)))
      .limit(1);
    if (existing) return 'duplicado';

    const sentAt = new Date(event.sentAt);
    const contactId = await this.upsertContact(tx, channel, event, sentAt);
    const conversationId = await this.openConversation(tx, channel, contactId, sentAt);

    // ON CONFLICT por si otro trabajo con el mismo mensaje ganó la carrera después del SELECT.
    const inserted = await tx
      .insert(messages)
      .values({
        tenantId: channel.tenantId,
        conversationId,
        channelId: channel.channelId,
        externalId: event.externalMessageId,
        direction: 'inbound',
        senderType: 'contact',
        type: event.messageType,
        body: event.body,
        status: 'received',
        raw: event.raw,
        sentAt,
      })
      .onConflictDoNothing({ target: [messages.channelId, messages.externalId] })
      .returning({ id: messages.id });
    if (inserted.length === 0) return 'duplicado';

    // GREATEST: si los trabajos se procesan desordenados, las fechas no retroceden.
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${sentAt})`,
        lastInboundAt: sql`GREATEST(COALESCE(${conversations.lastInboundAt}, ${sentAt}), ${sentAt})`,
      })
      .where(eq(conversations.id, conversationId));
    return 'guardado';
  }

  // Dos trabajos simultáneos del mismo contacto nuevo: el segundo INSERT espera al primero en el
  // UNIQUE (tenant_id, wa_id) y después toma la rama DO UPDATE sobre la misma fila.
  private async upsertContact(
    tx: AppTx,
    channel: ResolvedChannel,
    event: MessageReceivedEvent,
    sentAt: Date,
  ): Promise<string> {
    const [contact] = await tx
      .insert(contacts)
      .values({
        tenantId: channel.tenantId,
        waId: event.contact.waId,
        profileName: event.contact.profileName,
        firstSeenAt: sentAt,
        lastSeenAt: sentAt,
      })
      .onConflictDoUpdate({
        target: [contacts.tenantId, contacts.waId],
        set: {
          profileName: sql`COALESCE(excluded.profile_name, ${contacts.profileName})`,
          lastSeenAt: sql`GREATEST(${contacts.lastSeenAt}, excluded.last_seen_at)`,
        },
      })
      .returning({ id: contacts.id });
    return contact!.id;
  }

  // Buscar-o-crear contra el UNIQUE parcial conversations_open_unique (channel_id, contact_id) WHERE
  // status = 'open'. Si otro trabajo la creó en paralelo, el INSERT espera su commit y no inserta; el
  // SELECT siguiente (snapshot nuevo en READ COMMITTED) ya la ve.
  private async openConversation(
    tx: AppTx,
    channel: ResolvedChannel,
    contactId: string,
    sentAt: Date,
  ): Promise<string> {
    for (let attempt = 0; attempt < OPEN_CONVERSATION_ATTEMPTS; attempt++) {
      const [created] = await tx
        .insert(conversations)
        .values({
          tenantId: channel.tenantId,
          channelId: channel.channelId,
          contactId,
          lastMessageAt: sentAt,
        })
        .onConflictDoNothing({
          target: [conversations.channelId, conversations.contactId],
          where: sql`status = 'open'`,
        })
        .returning({ id: conversations.id });
      if (created) return created.id;

      const [open] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.channelId, channel.channelId),
            eq(conversations.contactId, contactId),
            eq(conversations.status, 'open'),
          ),
        )
        .limit(1);
      if (open) return open.id;
    }
    throw new Error('No se pudo obtener la conversación abierta');
  }

  // Nunca pone ni saca banned: eso no lo decide un evento del proveedor.
  private async updateChannelStatus(
    tx: AppTx,
    channel: ResolvedChannel,
    event: SessionStatusEvent,
  ): Promise<InboundResult> {
    const updated = await tx
      .update(channels)
      .set({ status: event.status })
      .where(
        and(
          eq(channels.id, channel.channelId),
          ne(channels.status, 'banned'),
          ne(channels.status, event.status),
        ),
      )
      .returning({ id: channels.id });
    return updated.length > 0 ? 'actualizado' : 'sin_cambios';
  }
}
