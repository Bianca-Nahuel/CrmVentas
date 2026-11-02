import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  MessageDeliveryStatus,
  MessageEchoEvent,
  MessageReceivedEvent,
  MessageStatusEvent,
  SessionStatusEvent,
  WhatsAppEvent,
} from '@ventas/shared';
import { and, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { AI_DEBOUNCE_SECONDS } from '../../ai/ai.constants.js';
import type { AiReplyJob } from '../../ai/reply/ai-reply.job.js';
import { APP_DB, type AppDatabase } from '../../db/database.module.js';
import {
  channelEvents,
  channels,
  contacts,
  conversations,
  messages,
  outboundMessages,
} from '../../db/schema/messaging.js';
import { withTenantTransaction, type AppTx } from '../../db/tenant-context.js';
import { errorCode } from '../../jobs/error-code.js';
import type { SessionCloseJob } from './session-close.job.js';
import { publishConversationEvent, publishNotice } from '../../realtime/publish.js';
import { BOSS, QUEUES } from '../../jobs/jobs.module.js';
import {
  ECHO_RECHECK_MAX,
  ECHO_RECONCILE_WINDOW_MS,
  REPLY_WINDOW_HOURS,
} from '../../messaging/outbound/outbound.constants.js';
import { pauseAiAfterHuman } from '../../messaging/outbound/outbound.service.js';
import { refreshConversationMetrics } from '../../performance/conversation-metrics.js';

/**
 * guardado/duplicado: mensaje entrante. propio: eco de algo que mandó el sistema. reconciliado: eco que
 * confirmó un envío de resultado desconocido. pausado: eco escrito por una persona (la IA se pausa).
 * reprogramar: eco con un envío en curso en el chat, hay que volver a mirarlo. actualizado/sin_cambios:
 * estado del canal o acuse. rechazado: el escaneo vinculó otro teléfono o un número que ya está en otro canal.
 */
export type InboundResult =
  | 'guardado'
  | 'duplicado'
  | 'propio'
  | 'reconciliado'
  | 'pausado'
  | 'reprogramar'
  | 'actualizado'
  | 'sin_cambios'
  | 'rechazado';

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
  private readonly logger = new Logger('InboundService');

  constructor(
    @Inject(APP_DB) private readonly database: AppDatabase,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

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

  /** echoAttempt: cuántas veces ya se reprogramó este eco (lo lleva el trabajo de la cola). */
  async process(event: WhatsAppEvent, channel: ResolvedChannel, echoAttempt = 0): Promise<InboundResult> {
    return withTenantTransaction(this.database.db, { tenantId: channel.tenantId }, (tx) => {
      switch (event.type) {
        case 'message.received':
          return this.saveMessage(tx, channel, event);
        case 'message.echo':
          return this.saveEcho(tx, channel, event, echoAttempt);
        case 'message.status':
          return this.updateMessageStatus(tx, channel, event);
        case 'session.status':
          return this.updateChannelStatus(tx, channel, event);
      }
    });
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
    await refreshConversationMetrics(tx, conversationId);

    // Agente (tarea 006): un trabajo por entrante nuevo, en esta misma transacción (existe solo si el
    // mensaje se guarda). Espera AI_DEBOUNCE_SECONDS para juntar mensajes seguidos; si al correr hay un
    // entrante más nuevo, no hace nada (lo procesa el trabajo de ese). Solo ids, nunca el texto.
    const job: AiReplyJob = { tenantId: channel.tenantId, conversationId, messageId: inserted[0]!.id };
    await this.boss.send(QUEUES.aiReply, job, {
      singletonKey: conversationId,
      startAfter: AI_DEBOUNCE_SECONDS,
      db: fromDrizzle(tx, sql),
    });
    await publishConversationEvent(tx, 'message.created', { ...ids(channel), conversationId });
    return 'guardado';
  }

  // Dos trabajos simultáneos del mismo contacto nuevo: el segundo INSERT espera al primero en el
  // UNIQUE (tenant_id, wa_id) y después toma la rama DO UPDATE sobre la misma fila.
  private async upsertContact(
    tx: AppTx,
    channel: ResolvedChannel,
    event: MessageReceivedEvent | MessageEchoEvent,
    sentAt: Date,
    // Un eco no es actividad del contacto: no mueve last_seen_at de un contacto que ya existe.
    options: { touchLastSeen: boolean } = { touchLastSeen: true },
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
          lastSeenAt: options.touchLastSeen
            ? sql`GREATEST(${contacts.lastSeenAt}, excluded.last_seen_at)`
            : sql`${contacts.lastSeenAt}`,
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

  /**
   * Conversación de un eco: la abierta; si no hay, la última cerrada de este contacto en este número si se
   * cerró dentro de la ventana de respuesta (tarea 026: el "gracias" del vendedor después de cerrar no abre
   * un lead nuevo ni la reabre); si no, una nueva (el número le escribe desde el teléfono a alguien de antes).
   */
  private async echoConversation(
    tx: AppTx,
    channel: ResolvedChannel,
    contactId: string,
    sentAt: Date,
  ): Promise<string> {
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
    const [closed] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.channelId, channel.channelId),
          eq(conversations.contactId, contactId),
          eq(conversations.status, 'closed'),
          gt(conversations.closedAt, sql`now() - make_interval(hours => ${REPLY_WINDOW_HOURS})`),
        ),
      )
      .orderBy(desc(conversations.closedAt), desc(conversations.id))
      .limit(1);
    if (closed) return closed.id;
    return this.openConversation(tx, channel, contactId, sentAt);
  }

  /**
   * Eco (mensaje que salió del número del canal). En orden:
   * 1. su id ya está en messages u outbound_messages → es nuestro (o un reenvío): no se toca nada;
   * 2. hay un envío en 'sending' en el canal → todavía no se sabe si es ese: se reprograma (hasta
   *    ECHO_RECHECK_MAX veces; después se trata como de una persona, que solo pausa la IA);
   * 3. coincide (texto exacto, últimos minutos) con un envío unknown_outcome → se confirma ese envío y,
   *    por las dudas, se pausa la IA igual;
   * 4. si no, lo escribió una persona desde el teléfono o WhatsApp Web: se guarda como 'user' sin
   *    usuario y se pausa la IA en la conversación (si no había conversación, se crea ya pausada).
   */
  private async saveEcho(
    tx: AppTx,
    channel: ResolvedChannel,
    event: MessageEchoEvent,
    echoAttempt: number,
  ): Promise<InboundResult> {
    const externalId = event.externalMessageId;
    const [known] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channel.channelId), eq(messages.externalId, externalId)))
      .limit(1);
    if (known) return 'duplicado';
    const [ours] = await tx
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(
        and(eq(outboundMessages.channelId, channel.channelId), eq(outboundMessages.externalId, externalId)),
      )
      .limit(1);
    if (ours) return 'propio';

    const sentAt = new Date(event.sentAt);
    const contactId = await this.upsertContact(tx, channel, event, sentAt, { touchLastSeen: false });
    const conversationId = await this.echoConversation(tx, channel, contactId, sentAt);

    // Visibilidad: el claim (queued → sending) se confirma antes de llamar al proveedor, así que un envío
    // en curso siempre se ve acá en 'sending'. Si terminó entre la consulta de arriba y esta, su mensaje
    // ya está en messages (misma transacción que el 'sent') y el INSERT de abajo choca: 'duplicado'.
    const [inFlight] = await tx
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      // A nivel de canal: si el chat del eco no se resolvió igual que el del envío (@lid sin número), el
      // envío en curso está en otra conversación. Como mucho demora unos segundos un eco de una persona.
      .where(and(eq(outboundMessages.channelId, channel.channelId), eq(outboundMessages.status, 'sending')))
      .limit(1);
    if (inFlight && echoAttempt < ECHO_RECHECK_MAX) return 'reprogramar';

    if (event.body !== null) {
      const [unknown] = await tx
        .select({
          id: outboundMessages.id,
          senderType: outboundMessages.senderType,
          sentByUserId: outboundMessages.sentByUserId,
        })
        .from(outboundMessages)
        .where(
          and(
            eq(outboundMessages.conversationId, conversationId),
            eq(outboundMessages.status, 'failed'),
            eq(outboundMessages.lastError, 'unknown_outcome'),
            isNull(outboundMessages.externalId),
            eq(outboundMessages.body, event.body),
            gt(
              outboundMessages.claimedAt,
              sql`now() - make_interval(secs => ${ECHO_RECONCILE_WINDOW_MS / 1000})`,
            ),
          ),
        )
        .orderBy(desc(outboundMessages.claimedAt))
        .limit(1);
      if (unknown) {
        const messageId = await this.insertOutbound(tx, channel, conversationId, event, sentAt, unknown);
        await tx
          .update(outboundMessages)
          .set({ status: 'sent', externalId, messageId, lastError: null })
          .where(eq(outboundMessages.id, unknown.id));
        // El envío pasa a 'sent' aunque el mensaje ya estuviera guardado: el panel lo tiene que ver.
        await publishConversationEvent(tx, 'message.updated', { ...ids(channel), conversationId });
        if (!messageId) return 'duplicado';
        // Igual se pausa: si en realidad lo escribió una persona con el mismo texto (un "Gracias"), la IA
        // no tiene que responderle encima. Equivocarse acá solo pausa la IA.
        await pauseAiAfterHuman(tx, conversationId);
        return 'reconciliado';
      }
    }

    const messageId = await this.insertOutbound(tx, channel, conversationId, event, sentAt, {
      senderType: 'user',
      sentByUserId: null,
    });
    if (!messageId) return 'duplicado';
    await pauseAiAfterHuman(tx, conversationId);
    await publishConversationEvent(tx, 'message.created', { ...ids(channel), conversationId });
    return 'pausado';
  }

  /** Mensaje saliente de un eco. Devuelve su id, o null si otro trabajo ya lo guardó. */
  private async insertOutbound(
    tx: AppTx,
    channel: ResolvedChannel,
    conversationId: string,
    event: MessageEchoEvent,
    sentAt: Date,
    sender: { senderType: string; sentByUserId: string | null },
  ): Promise<string | null> {
    const [inserted] = await tx
      .insert(messages)
      .values({
        tenantId: channel.tenantId,
        conversationId,
        channelId: channel.channelId,
        externalId: event.externalMessageId,
        direction: 'outbound',
        senderType: sender.senderType,
        sentByUserId: sender.sentByUserId,
        type: event.messageType,
        body: event.body,
        status: 'sent',
        raw: event.raw,
        sentAt,
      })
      .onConflictDoNothing({ target: [messages.channelId, messages.externalId] })
      .returning({ id: messages.id });
    if (!inserted) return null;
    await tx
      .update(conversations)
      .set({ lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${sentAt})` })
      .where(eq(conversations.id, conversationId));
    await refreshConversationMetrics(tx, conversationId);
    return inserted.id;
  }

  /**
   * Acuse de un mensaje propio. Nunca retrocede (sent < delivered < read); failed solo pisa a sent, y un
   * acuse posterior a un failed (entregado, leído) lo corrige: el mensaje llegó.
   * Si el mensaje no existe (todavía o nunca), no hace nada: no se reintenta.
   */
  private async updateMessageStatus(
    tx: AppTx,
    channel: ResolvedChannel,
    event: MessageStatusEvent,
  ): Promise<InboundResult> {
    const allowedFrom: Record<MessageDeliveryStatus, string[]> = {
      sent: ['failed'],
      delivered: ['sent', 'failed'],
      read: ['sent', 'delivered', 'failed'],
      failed: ['sent'],
    };
    const updated = await tx
      .update(messages)
      .set({ status: event.status })
      .where(
        and(
          eq(messages.channelId, channel.channelId),
          eq(messages.externalId, event.externalMessageId),
          eq(messages.direction, 'outbound'),
          inArray(messages.status, allowedFrom[event.status]),
        ),
      )
      .returning({ id: messages.id, conversationId: messages.conversationId });
    for (const row of updated) {
      await publishConversationEvent(tx, 'message.updated', {
        ...ids(channel),
        conversationId: row.conversationId,
      });
    }
    return updated.length > 0 ? 'actualizado' : 'sin_cambios';
  }

  // Nunca pone ni saca banned: eso no lo decide un evento del proveedor.
  private async updateChannelStatus(
    tx: AppTx,
    channel: ResolvedChannel,
    event: SessionStatusEvent,
  ): Promise<InboundResult> {
    const [current] = await tx
      .select({
        status: channels.status,
        phoneNumber: channels.phoneNumber,
        connectedAt: channels.connectedAt,
        disconnectReason: channels.disconnectReason,
      })
      .from(channels)
      .where(eq(channels.id, channel.channelId))
      .for('update');
    if (!current || current.status === 'banned') return 'sin_cambios';
    if (event.status === 'connected') return this.connectChannel(tx, channel, current, event);
    if (current.status === event.status) return 'sin_cambios';
    // Un canal esperando el escaneo pasa por STOPPED cuando se pide un QR nuevo (restartPairing): eso no
    // es una desconexión. Sí lo es que la sesión falle (por ejemplo, se agotaron los QR).
    if (current.status === 'pending' && event.status === 'disconnected' && !event.failed)
      return 'sin_cambios';

    const disconnected = event.status === 'disconnected';
    const failure =
      disconnected && event.failed
        ? (await this.waitingForScan(tx, channel.channelId))
          ? 'pairing_expired'
          : 'session_failed'
        : null;
    await tx
      .update(channels)
      .set(
        disconnected
          ? {
              status: 'disconnected',
              disconnectedAt: sql`now()`,
              disconnectReason: failure,
            }
          : { status: event.status },
      )
      .where(eq(channels.id, channel.channelId));
    if (disconnected && current.status === 'connected') {
      await tx.insert(channelEvents).values({
        tenantId: channel.tenantId,
        channelId: channel.channelId,
        type: 'disconnected',
        data: { by: 'provider', failed: event.failed },
      });
    }
    await publishNotice(tx, { kind: 'channel', type: 'channel.updated', ...ids(channel) });
    return 'actualizado';
  }

  /**
   * La sesión esperaba un escaneo: lo último del canal fue el alta o un pedido de reconectar (QR nuevo). Si
   * falla así, se agotaron los QR. Un canal que se cae y el proveedor vuelve a levantar también pasa por
   * pending, pero sin pedido de por medio: esa falla es de la sesión.
   */
  private async waitingForScan(tx: AppTx, channelId: string): Promise<boolean> {
    const [last] = await tx
      .select({ type: channelEvents.type })
      .from(channelEvents)
      .where(
        and(
          eq(channelEvents.channelId, channelId),
          inArray(channelEvents.type, ['created', 'reconnect_requested', 'connected']),
        ),
      )
      .orderBy(desc(channelEvents.createdAt), desc(channelEvents.id))
      .limit(1);
    return last?.type === 'created' || last?.type === 'reconnect_requested';
  }

  /**
   * Sesión vinculada. El número sale del escaneo (decisión #27) y nunca pisa al que ya tenía el canal:
   * - otro teléfono que el del canal → phone_mismatch;
   * - un número que ya tiene otro canal (de esta empresa o de otra: UNIQUE global) → number_in_use.
   * En los dos casos el canal queda desconectado con su motivo, sin reintentos, y se encola la
   * desvinculación en el proveedor (hasta entonces resolve_channel descarta lo que llegue por esa sesión).
   */
  private async connectChannel(
    tx: AppTx,
    channel: ResolvedChannel,
    current: {
      status: string;
      phoneNumber: string | null;
      connectedAt: Date | null;
      disconnectReason: string | null;
    },
    event: SessionStatusEvent,
  ): Promise<InboundResult> {
    // Lo desconectó una persona: un WORKING que ya estaba en la cola no lo vuelve a conectar (el camino es
    // reconectar, que lo pasa a pending).
    if (current.status === 'disconnected' && current.disconnectReason === 'logged_out') return 'sin_cambios';
    // Sin el número en el evento, el del canal vale solo si no hubo un QR de por medio (el proveedor volvió a
    // levantar la misma sesión). Después de un escaneo, el número viejo no sirve: podría ser otro teléfono
    // o uno de otra empresa.
    const keepsPhone =
      !event.phoneNumber &&
      current.phoneNumber !== null &&
      (current.status === 'connected' || !(await this.waitingForScan(tx, channel.channelId)));
    const phone = event.phoneNumber ?? (keepsPhone ? current.phoneNumber : null);
    if (!phone) {
      // Sin número no se puede marcar conectado (CHECK): queda como estaba y se registra.
      this.logger.warn({ msg: 'session.status', channelId: channel.channelId, result: 'sin_numero' });
      return 'sin_cambios';
    }
    if (current.phoneNumber && event.phoneNumber && current.phoneNumber !== event.phoneNumber) {
      return this.rejectScan(tx, channel, 'phone_mismatch', {});
    }
    if (current.status === 'connected' && current.phoneNumber === phone) return 'sin_cambios';

    try {
      // Savepoint: si el UNIQUE choca, la transacción sigue para registrar el rechazo.
      await tx.transaction(async (savepoint) => {
        await savepoint
          .update(channels)
          .set({
            status: 'connected',
            phoneNumber: phone,
            connectedAt: sql`now()`,
            disconnectedAt: null,
            disconnectReason: null,
          })
          .where(eq(channels.id, channel.channelId));
      });
    } catch (error) {
      if (errorCode(error) !== '23505') throw error;
      // RLS: solo se ven los canales de esta empresa. Si no aparece, está en otra (no se dice cuál).
      const [sameTenant] = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.phoneNumber, phone), ne(channels.id, channel.channelId)))
        .limit(1);
      return this.rejectScan(tx, channel, 'number_in_use', {
        scope: sameTenant ? 'same_tenant' : 'other_tenant',
        ...(sameTenant ? { otherChannelId: sameTenant.id } : {}),
      });
    }
    await tx.insert(channelEvents).values({
      tenantId: channel.tenantId,
      channelId: channel.channelId,
      type: 'connected',
      data: { first: current.connectedAt === null && current.phoneNumber === null },
    });
    await publishNotice(tx, { kind: 'channel', type: 'channel.updated', ...ids(channel) });
    return 'actualizado';
  }

  private async rejectScan(
    tx: AppTx,
    channel: ResolvedChannel,
    reason: 'phone_mismatch' | 'number_in_use',
    data: Record<string, string>,
  ): Promise<InboundResult> {
    await tx
      .update(channels)
      .set({ status: 'disconnected', disconnectedAt: sql`now()`, disconnectReason: reason })
      .where(eq(channels.id, channel.channelId));
    await tx.insert(channelEvents).values({
      tenantId: channel.tenantId,
      channelId: channel.channelId,
      type: reason,
      data,
    });
    const job: SessionCloseJob = { tenantId: channel.tenantId, channelId: channel.channelId };
    await this.boss.send(QUEUES.whatsappSessionClose, job, { db: fromDrizzle(tx, sql) });
    await publishNotice(tx, { kind: 'channel', type: 'channel.updated', ...ids(channel) });
    // Sin el número: solo ids y el motivo.
    this.logger.warn({ msg: 'session.status', channelId: channel.channelId, result: 'rechazado', reason });
    return 'rechazado';
  }
}

/** Empresa y número de un evento, para los avisos de tiempo real (se publican dentro de la transacción). */
function ids(channel: ResolvedChannel): { tenantId: string; channelId: string } {
  return { tenantId: channel.tenantId, channelId: channel.channelId };
}
