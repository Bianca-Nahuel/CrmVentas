import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { channels, conversations, outboundMessages } from '../../db/schema/messaging.js';
import { currentTx, type AppTx } from '../../db/tenant-context.js';
import { publishConversationEvent, publishNotice } from '../../realtime/publish.js';
import { BOSS, QUEUES } from '../../jobs/jobs.module.js';
import {
  WHATSAPP_PROVIDER_REGISTRY,
  type ProviderFailure,
  type SeenMessage,
  type WhatsAppProviderRegistry,
} from '../../whatsapp/provider.js';
import { AI_PAUSE_AFTER_HUMAN_HOURS, REPLY_WINDOW_HOURS } from './outbound.constants.js';

export type OutboundSenderType = 'ai' | 'user' | 'app';
export type RejectReason =
  | 'no_inbound'
  | 'window_expired'
  | 'contact_blocked'
  | 'channel_unavailable'
  | 'channel_paused'
  | 'conversation_closed'
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

/**
 * Proveedores en los que una persona del equipo puede responder fuera de la ventana desde el último
 * entrante (capabilities.within24hWindowOnly = false). La IA y los textos de la app la respetan siempre.
 */
export function humanReplyWindowFreeProviders(providers: WhatsAppProviderRegistry): string[] {
  return [...providers.values()]
    .filter((provider) => !provider.capabilities.within24hWindowOnly)
    .map((provider) => provider.id);
}

/**
 * Por qué no se puede enviar en una conversación (c = conversations, ct = contacts, ch = channels), o NULL
 * si se puede. La usan loadSendContext y el detalle de la conversación del panel (que explica el motivo).
 * `windowFreeProviders`: los canales de esos proveedores no vencen por la ventana (respuestas de personas,
 * ver humanReplyWindowFreeProviders); un proveedor que no esté en la lista la respeta.
 */
export function sendRejectReason(windowFreeProviders: readonly string[] = []) {
  return sql`CASE
  WHEN c.status <> 'open' THEN 'conversation_closed'
  WHEN c.last_inbound_at IS NULL THEN 'no_inbound'
  WHEN c.last_inbound_at <= now() - make_interval(hours => ${REPLY_WINDOW_HOURS})
    AND NOT (ch.provider = ANY (string_to_array(${windowFreeProviders.join(',')}, ','))) THEN 'window_expired'
  WHEN ct.blocked THEN 'contact_blocked'
  WHEN ch.status <> 'connected' OR ch.external_id IS NULL THEN 'channel_unavailable'
  WHEN ch.sending_paused_until IS NOT NULL AND ch.sending_paused_until > now() THEN 'channel_paused'
END`;
}

/**
 * Una persona respondió (desde el teléfono o el panel): la IA no se mete en la conversación por
 * AI_PAUSE_AFTER_HUMAN_HOURS. Nunca acorta una pausa más larga.
 */
export async function pauseAiAfterHuman(tx: AppTx, conversationId: string): Promise<void> {
  await tx
    .update(conversations)
    .set({
      aiPausedUntil: sql`GREATEST(COALESCE(${conversations.aiPausedUntil}, now()), now() + make_interval(hours => ${AI_PAUSE_AFTER_HUMAN_HOURS}))`,
    })
    .where(eq(conversations.id, conversationId));
}

/**
 * Deja sin efecto las respuestas de la IA que todavía esperan en la cola (rejected/superseded): respondió
 * una persona. Una que ya está en 'sending' sale igual (el claim es atómico y nunca se corta un envío).
 */
export async function supersedeQueuedAiReplies(tx: AppTx, conversationId: string): Promise<number> {
  const rows = await tx
    .update(outboundMessages)
    .set({ status: 'rejected', rejectReason: 'superseded' })
    .where(
      and(
        eq(outboundMessages.conversationId, conversationId),
        eq(outboundMessages.senderType, 'ai'),
        eq(outboundMessages.status, 'queued'),
      ),
    )
    .returning({ id: outboundMessages.id });
  return rows.length;
}

export const MAX_BODY_CHARS = 4096;
const MAX_KEY_CHARS = 200;

/**
 * Reglas de envío. Valen para toda conexión: ningún canal inicia conversaciones. La IA y la app nunca
 * escriben fuera de la ventana desde el último entrante; una persona del equipo sí, en los proveedores que
 * no la exigen (`windowFreeProviders`, decisión #112). En la oficial, fuera de la ventana solo van
 * plantillas, que todavía no se mandan.
 */
export async function loadSendContext(
  tx: AppTx,
  conversationId: string,
  windowFreeProviders: readonly string[] = [],
): Promise<SendContext | null> {
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
           ct.wa_id AS contact_wa_id, c.last_inbound_at, ${sendRejectReason(windowFreeProviders)} AS reject_reason
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
  private readonly windowFreeProviders: readonly string[];

  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(WHATSAPP_PROVIDER_REGISTRY) providers: WhatsAppProviderRegistry,
  ) {
    this.windowFreeProviders = humanReplyWindowFreeProviders(providers);
  }

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

    const context = await loadSendContext(
      tx,
      input.conversationId,
      input.senderType === 'user' ? this.windowFreeProviders : [],
    );
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
      // No visible: la clave es de un envío en un número que este usuario no ve (RLS channel_visibility).
      // Es otro envío: conflicto, sin revelar nada de esa fila.
      if (!winner) throw new IdempotencyConflictError();
      return sameRequest(winner, input, sentByUserId);
    }

    // Tiempo real: el envío aparece "En cola" (o rechazado) en el panel cuando la transacción hace commit.
    await publishConversationEvent(tx, 'message.created', {
      tenantId: inserted.tenantId,
      channelId: context.channelId,
      conversationId: context.conversationId,
    });

    if (status === 'queued') {
      const job: OutboundJob = {
        outboundId: inserted.id,
        tenantId: inserted.tenantId,
        ...(input.typingSince ? { typingSince: input.typingSince.toISOString() } : {}),
      };
      await this.boss.send(QUEUES.whatsappOutbound, job, {
        singletonKey: context.conversationId,
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
  let changed: { tenantId: string }[];
  if (failure.error === 'blocked_risk') {
    changed = await tx
      .update(channels)
      .set({
        sendingPausedUntil: sql`'infinity'::timestamptz`,
        sendingPausedReason: `blocked_risk:${failure.code}`,
      })
      .where(eq(channels.id, channelId))
      .returning({ tenantId: channels.tenantId });
  } else if (failure.error === 'session_down') {
    changed = await tx
      .update(channels)
      .set({ status: 'disconnected' })
      .where(and(eq(channels.id, channelId), inArray(channels.status, ['pending', 'connected'])))
      .returning({ tenantId: channels.tenantId });
  } else {
    return false;
  }
  // El panel muestra por qué no se puede responder (tiempo real).
  for (const row of changed) {
    await publishNotice(tx, { kind: 'channel', type: 'channel.updated', tenantId: row.tenantId, channelId });
  }
  return true;
}
