import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { channels, outboundMessages } from '../../db/schema/messaging.js';
import { currentTx, type AppTx } from '../../db/tenant-context.js';
import { BOSS, QUEUES } from '../../jobs/jobs.module.js';
import type { ProviderFailure, SeenMessage } from '../../whatsapp/provider.js';
import { NEXT_PART_START_AFTER_SECONDS, REPLY_WINDOW_HOURS } from './outbound.constants.js';

export type OutboundSenderType = 'ai' | 'user' | 'app';
export type RejectReason =
  | 'no_inbound'
  | 'window_expired'
  | 'contact_blocked'
  | 'channel_unavailable'
  | 'channel_paused'
  /** Parte siguiente de una respuesta que ya no corresponde (ver EnqueueTextInput.afterOutboundId). */
  | 'superseded';
export type OutboundStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'rejected';

export interface EnqueueTextInput {
  conversationId: string;
  body: string;
  senderType: OutboundSenderType;
  /** Obligatorio si senderType = 'user' (el usuario del panel); null para la IA y la app. */
  sentByUserId?: string | null;
  /** Clave del que pide el envío (por ejemplo, el id del mensaje entrante al que responde la IA). */
  idempotencyKey: string;
  /**
   * Desde cuándo el chat ya muestra "escribiendo…" (PresenceService, mientras la IA pensaba): el worker
   * descuenta ese tiempo de la demora antes de enviar.
   */
  typingSince?: Date | null;
  /**
   * Parte siguiente de una respuesta en varios mensajes (tarea 010): sale después de que salió esta otra
   * fila y se rechaza ('superseded') si esa no salió, si escribió el cliente o si respondió una persona.
   */
  afterOutboundId?: string;
}

export interface EnqueueTextResult {
  outboundId: string;
  status: OutboundStatus;
  rejectReason: RejectReason | null;
  /** false si la clave ya existía y se devolvió la fila de entonces. */
  created: boolean;
}

/** Trabajo de whatsapp-outbound: solo ids (el texto queda en outbound_messages). */
export interface OutboundJob {
  outboundId: string;
  tenantId: string;
  /** Separación con el saliente anterior del chat, sorteada una vez y conservada al reprogramar. */
  gapMs?: number;
  /** ISO: desde cuándo el chat ya muestra "escribiendo…" (ver EnqueueTextInput.typingSince). */
  typingSince?: string;
  /** Ver EnqueueTextInput.afterOutboundId. */
  afterOutboundId?: string;
}

/** Destino y reglas de envío de una conversación, evaluadas en la base con su now(). */
export interface SendContext {
  conversationId: string;
  channelId: string;
  channelExternalId: string;
  provider: string;
  contactWaId: string;
  lastInboundAt: Date | null;
  rejectReason: RejectReason | null;
}

export class ConversationNotFoundError extends Error {
  constructor() {
    super('La conversación no existe en esta empresa');
    this.name = 'ConversationNotFoundError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('La clave de idempotencia ya se usó para otro envío');
    this.name = 'IdempotencyConflictError';
  }
}

export class InvalidOutboundError extends Error {
  constructor(reason: string) {
    super(`Envío inválido: ${reason}`);
    this.name = 'InvalidOutboundError';
  }
}

const MAX_BODY_CHARS = 4096;
const MAX_KEY_CHARS = 200;

/**
 * Reglas de envío. Valen para toda conexión: ningún canal inicia conversaciones ni escribe fuera de la
 * ventana desde el último entrante (en la no oficial, por riesgo de bloqueo; en la oficial, porque fuera
 * de la ventana solo van plantillas, que todavía no se mandan).
 */
export async function loadSendContext(tx: AppTx, conversationId: string): Promise<SendContext | null> {
  const result = await tx.execute<{
    conversation_id: string;
    channel_id: string;
    channel_external_id: string | null;
    provider: string;
    contact_wa_id: string;
    last_inbound_at: Date | string | null;
    reject_reason: RejectReason | null;
  }>(sql`
    SELECT c.id AS conversation_id, c.channel_id, ch.external_id AS channel_external_id, ch.provider,
           ct.wa_id AS contact_wa_id, c.last_inbound_at,
           CASE
             WHEN c.last_inbound_at IS NULL THEN 'no_inbound'
             WHEN c.last_inbound_at <= now() - make_interval(hours => ${REPLY_WINDOW_HOURS}) THEN 'window_expired'
             WHEN ct.blocked THEN 'contact_blocked'
             WHEN ch.status <> 'connected' OR ch.external_id IS NULL THEN 'channel_unavailable'
             WHEN ch.sending_paused_until IS NOT NULL AND ch.sending_paused_until > now() THEN 'channel_paused'
           END AS reject_reason
    FROM conversations c
    JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
    JOIN channels ch ON ch.tenant_id = c.tenant_id AND ch.id = c.channel_id
    WHERE c.id = ${conversationId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    channelId: row.channel_id,
    channelExternalId: row.channel_external_id ?? '',
    provider: row.provider,
    contactWaId: row.contact_wa_id,
    lastInboundAt: row.last_inbound_at === null ? null : new Date(row.last_inbound_at),
    rejectReason: row.reject_reason,
  };
}

// Encola envíos de texto. Es la única puerta de salida: la IA (tarea 006), el panel (011) y dev:send
// pasan por acá, con las mismas reglas. Corre en la transacción de empresa del que llama (la del request
// por defecto, o la que pase un worker): la fila y el trabajo de la cola se confirman juntos.
@Injectable()
export class OutboundService {
  constructor(@Inject(BOSS) private readonly boss: PgBoss) {}

  /**
   * Idempotente por (empresa, idempotencyKey): repetir la clave devuelve la fila de la primera vez, en el
   * estado en que esté. Un envío `rejected` queda rechazado para esa clave (no se vuelven a evaluar las
   * reglas): para intentar de nuevo hay que usar otra clave. La misma clave con otro destino, texto o
   * remitente es un error (IdempotencyConflictError).
   */
  async enqueueText(input: EnqueueTextInput, tx: AppTx = currentTx()): Promise<EnqueueTextResult> {
    validate(input);
    const sentByUserId = input.sentByUserId ?? null;

    const existing = await this.findByKey(tx, input.idempotencyKey);
    if (existing) return sameRequest(existing, input, sentByUserId);

    const context = await loadSendContext(tx, input.conversationId);
    if (!context) throw new ConversationNotFoundError();

    const status: OutboundStatus = context.rejectReason ? 'rejected' : 'queued';
    const [inserted] = await tx
      .insert(outboundMessages)
      .values({
        tenantId: sql`app_tenant_id()`,
        conversationId: context.conversationId,
        channelId: context.channelId,
        idempotencyKey: input.idempotencyKey,
        senderType: input.senderType,
        sentByUserId,
        body: input.body,
        status,
        rejectReason: context.rejectReason,
      })
      .onConflictDoNothing({ target: [outboundMessages.tenantId, outboundMessages.idempotencyKey] })
      .returning({ id: outboundMessages.id, tenantId: outboundMessages.tenantId });

    if (!inserted) {
      // Otro pedido con la misma clave ganó la carrera (el INSERT esperó su commit).
      const winner = await this.findByKey(tx, input.idempotencyKey);
      if (!winner) throw new Error('No se encontró el envío con la clave repetida');
      return sameRequest(winner, input, sentByUserId);
    }

    if (status === 'queued') {
      const job: OutboundJob = {
        outboundId: inserted.id,
        tenantId: inserted.tenantId,
        ...(input.typingSince ? { typingSince: input.typingSince.toISOString() } : {}),
        ...(input.afterOutboundId ? { afterOutboundId: input.afterOutboundId } : {}),
      };
      await this.boss.send(QUEUES.whatsappOutbound, job, {
        singletonKey: context.conversationId,
        // Una parte siguiente arranca un poco después, para no competir con la anterior en la cola.
        ...(input.afterOutboundId ? { startAfter: NEXT_PART_START_AFTER_SECONDS } : {}),
        // Misma transacción: el trabajo existe solo si la fila se confirma.
        db: fromDrizzle(tx, sql),
      });
    }
    return { outboundId: inserted.id, status, rejectReason: context.rejectReason, created: true };
  }

  private async findByKey(tx: AppTx, idempotencyKey: string) {
    const [row] = await tx
      .select({
        id: outboundMessages.id,
        conversationId: outboundMessages.conversationId,
        body: outboundMessages.body,
        senderType: outboundMessages.senderType,
        sentByUserId: outboundMessages.sentByUserId,
        status: outboundMessages.status,
        rejectReason: outboundMessages.rejectReason,
      })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.tenantId, sql`app_tenant_id()`),
          eq(outboundMessages.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row;
  }
}

function validate(input: EnqueueTextInput): void {
  const chars = [...input.body].length;
  if (chars < 1 || chars > MAX_BODY_CHARS || input.body.trim() === '') {
    throw new InvalidOutboundError('texto vacío o de más de 4096 caracteres');
  }
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > MAX_KEY_CHARS) {
    throw new InvalidOutboundError('clave de idempotencia vacía o de más de 200 caracteres');
  }
  if ((input.senderType === 'user') !== Boolean(input.sentByUserId)) {
    throw new InvalidOutboundError('sentByUserId va solo (y siempre) con senderType = user');
  }
}

function sameRequest(
  row: {
    id: string;
    conversationId: string;
    body: string;
    senderType: string;
    sentByUserId: string | null;
    status: string;
    rejectReason: string | null;
  },
  input: EnqueueTextInput,
  sentByUserId: string | null,
): EnqueueTextResult {
  if (
    row.conversationId !== input.conversationId ||
    row.body !== input.body ||
    row.senderType !== input.senderType ||
    row.sentByUserId !== sentByUserId
  ) {
    throw new IdempotencyConflictError();
  }
  return {
    outboundId: row.id,
    status: row.status as OutboundStatus,
    rejectReason: row.rejectReason as RejectReason | null,
    created: false,
  };
}

/** Entrantes posteriores al último saliente (hasta 20), con su raw: los que hay que marcar como vistos. */
export async function unreadInbound(tx: AppTx, conversationId: string): Promise<SeenMessage[]> {
  const result = await tx.execute<{ external_id: string; raw: unknown }>(sql`
    SELECT external_id, raw FROM (
      SELECT m.external_id, m.raw, m.sent_at FROM messages m
      WHERE m.conversation_id = ${conversationId}
        AND m.direction = 'inbound'
        AND m.sent_at > COALESCE(
          (SELECT max(o.sent_at) FROM messages o
           WHERE o.conversation_id = ${conversationId} AND o.direction = 'outbound'),
          '-infinity'::timestamptz)
      ORDER BY m.sent_at DESC
      LIMIT 20
    ) recent ORDER BY sent_at
  `);
  return result.rows.map((row) => ({ externalId: row.external_id, raw: row.raw }));
}

/**
 * Lo que un error del proveedor le hace al canal, venga de un envío o de la presencia (visto,
 * escribiendo): blocked_risk (463/475) pausa los envíos sin vencimiento, hasta que una persona lo levante
 * (dev:resume-channel; después, el panel), sin reiniciar ni re-vincular la sesión; session_down lo marca
 * desconectado. Con el canal así, loadSendContext rechaza todo envío nuevo. Devuelve true si cambió algo.
 */
export async function applyChannelFailure(
  tx: AppTx,
  channelId: string,
  failure: ProviderFailure,
): Promise<boolean> {
  if (failure.error === 'blocked_risk') {
    await tx
      .update(channels)
      .set({
        sendingPausedUntil: sql`'infinity'::timestamptz`,
        sendingPausedReason: `blocked_risk:${failure.code}`,
      })
      .where(eq(channels.id, channelId));
    return true;
  }
  if (failure.error === 'session_down') {
    await tx
      .update(channels)
      .set({ status: 'disconnected' })
      .where(and(eq(channels.id, channelId), inArray(channels.status, ['pending', 'connected'])));
    return true;
  }
  return false;
}
