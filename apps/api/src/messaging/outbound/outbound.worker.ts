import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { APP_DB, type AppDatabase } from '../../db/database.module.js';
import { conversations, messages, outboundMessages } from '../../db/schema/messaging.js';
import { withTenantTransaction, type AppTx } from '../../db/tenant-context.js';
import { errorCode } from '../../jobs/error-code.js';
import { BOSS, QUEUES } from '../../jobs/jobs.module.js';
import {
  WHATSAPP_PROVIDER_REGISTRY,
  type ChatTarget,
  type PresenceResult,
  type ProviderFailure,
  type SeenMessage,
  type SendResult,
  type WhatsAppProvider,
  type WhatsAppProviderRegistry,
} from '../../whatsapp/provider.js';
import type { JobAttempt } from '../../whatsapp/inbound/inbound.worker.js';
import {
  MAX_SENDS_PER_MINUTE_PER_CHANNEL,
  RATE_WINDOW_MS,
  STUCK_SENDING_AFTER_MS,
  TYPING_INDICATOR_MAX_MS,
  sameChatGapMs,
  typingDelayMs,
} from './outbound.constants.js';
import {
  applyChannelFailure,
  loadSendContext,
  unreadInbound,
  type OutboundJob,
  type SendContext,
} from './outbound.service.js';

const WORK_OPTIONS = { localConcurrency: 4, pollingIntervalSeconds: 1, includeMetadata: true } as const;

// Si otro envío del chat está en curso (solo pasa si un trabajo venció o se cayó el proceso), se vuelve a
// mirar en este lapso.
const BUSY_CHAT_RETRY_MS = 10_000;

/** Espera y azar del worker: inyectables para que los tests no esperen ni dependan de la suerte. */
export interface OutboundTiming {
  sleep(ms: number): Promise<void>;
  random(): number;
}
export const OUTBOUND_TIMING = Symbol('OUTBOUND_TIMING');
const REAL_TIMING: OutboundTiming = { sleep: (ms) => sleep(ms), random: Math.random };

export type OutboundOutcome =
  'enviado' | 'rechazado' | 'reprogramado' | 'fallido' | 'reintento' | 'sin_cambios';

type ClaimResult =
  | { kind: 'done'; result: OutboundOutcome; reason?: string }
  | { kind: 'reschedule'; conversationId: string; startAfter: Date; gapMs?: number; reason: string }
  | { kind: 'send'; context: SendContext; body: string; unread: SeenMessage[] };

// Worker de whatsapp-outbound: visto → escribiendo → espera → dejar de escribir → enviar.
// Tres barreras contra un doble envío: la cola (policy singleton por conversación), el lock por canal
// en el claim y el claim atómico (queued → sending). Una fila en 'sending' NUNCA se vuelve a mandar: si
// el trabajo se reintenta o vence después del claim, se espera a que termine o se da por unknown_outcome.
// Las llamadas al proveedor van fuera de toda transacción (no se tiene una conexión tomada ~40 s).
// Logs: ids, resultado y código de error. Nunca teléfono, nombre ni texto.
@Injectable()
export class OutboundWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger('OutboundWorker');
  private readonly timing: OutboundTiming;

  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(WHATSAPP_PROVIDER_REGISTRY) private readonly providers: WhatsAppProviderRegistry,
    @Inject(APP_DB) private readonly database: AppDatabase,
    @Optional() @Inject(OUTBOUND_TIMING) timing?: OutboundTiming,
  ) {
    this.timing = timing ?? REAL_TIMING;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work<OutboundJob, unknown, typeof WORK_OPTIONS>(
      QUEUES.whatsappOutbound,
      WORK_OPTIONS,
      async (jobs) => {
        for (const job of jobs) await this.handle(job.data, job);
      },
    );
  }

  /** Procesa un trabajo. Lanza solo para que pg-boss reintente (lo que seguro no salió). */
  async handle(job: OutboundJob, attempt: JobAttempt): Promise<OutboundOutcome> {
    const base = { msg: 'outbound', jobId: attempt.id, outboundId: job.outboundId };
    let outcome: OutboundOutcome;
    let retryCode: string | null;
    try {
      ({ outcome, retryCode } = await this.process(job, attempt, base));
    } catch (error) {
      const final = attempt.retryCount >= attempt.retryLimit;
      const code = errorCode(error);
      this.logger[final ? 'error' : 'warn']({
        ...base,
        retryCount: attempt.retryCount,
        code,
        result: 'error',
      });
      // Sin cause a propósito: los errores de Drizzle traen la consulta con sus parámetros (el texto).
      // eslint-disable-next-line preserve-caught-error -- ver arriba
      throw new Error(`Falló el envío (código ${code})`);
    }
    if (retryCode) throw new Error(`Envío no salió, se reintenta (código ${retryCode})`);
    return outcome;
  }

  private async process(
    job: OutboundJob,
    attempt: JobAttempt,
    base: Record<string, unknown>,
  ): Promise<{ outcome: OutboundOutcome; retryCode: string | null }> {
    const claim = await withTenantTransaction(this.database.db, { tenantId: job.tenantId }, (tx) =>
      this.claim(tx, job),
    );

    if (claim.kind === 'done') {
      this.logger.log({ ...base, result: claim.result, ...(claim.reason ? { reason: claim.reason } : {}) });
      return { outcome: claim.result, retryCode: null };
    }
    if (claim.kind === 'reschedule') {
      await this.boss.send(
        QUEUES.whatsappOutbound,
        // Sin typingSince: para cuando corra, ese "escribiendo…" ya venció.
        {
          outboundId: job.outboundId,
          tenantId: job.tenantId,
          ...(job.gapMs === undefined ? {} : { gapMs: job.gapMs }),
          ...(claim.gapMs === undefined ? {} : { gapMs: claim.gapMs }),
        } satisfies OutboundJob,
        { singletonKey: claim.conversationId, startAfter: claim.startAfter },
      );
      this.logger.log({ ...base, result: 'reprogramado', reason: claim.reason });
      return { outcome: 'reprogramado', retryCode: null };
    }

    const { context, body, unread } = claim;
    const log = { ...base, channelId: context.channelId, conversationId: context.conversationId };
    const provider = this.providers.get(context.provider as WhatsAppProvider['id']);
    const result: SendResult = provider
      ? await this.deliver(
          provider,
          { channelExternalId: context.channelExternalId, waId: context.contactWaId },
          body,
          unread,
          log,
          // Un reintento ya no tiene el "escribiendo…" de la IA a la vista.
          job.typingSince && attempt.retryCount === 0 ? new Date(job.typingSince) : null,
        )
      : { ok: false, error: 'invalid_recipient', code: 'unknown_provider' };

    const final = attempt.retryCount >= attempt.retryLimit;
    const outcome = await withTenantTransaction(this.database.db, { tenantId: job.tenantId }, (tx) =>
      result.ok
        ? this.recordSent(tx, job, context, body, result)
        : this.recordFailure(tx, job, context, result, final),
    );
    if (result.ok) {
      this.logger.log({ ...log, result: 'enviado' });
    } else {
      const level = result.error === 'blocked_risk' ? 'error' : 'warn';
      this.logger[level]({
        ...log,
        result: outcome,
        error: result.error,
        code: result.code,
        ...(result.error === 'blocked_risk' ? { alerta: 'envios_del_canal_pausados' } : {}),
      });
    }
    return { outcome, retryCode: outcome === 'reintento' && !result.ok ? result.code : null };
  }

  /** T1: lock del canal, reglas, límites y claim (queued → sending). Transacción corta. */
  private async claim(tx: AppTx, job: OutboundJob): Promise<ClaimResult> {
    const [target] = await tx
      .select({ channelId: outboundMessages.channelId })
      .from(outboundMessages)
      .where(eq(outboundMessages.id, job.outboundId));
    if (!target) return { kind: 'done', result: 'sin_cambios', reason: 'not_found' };

    // Serializa los claims del canal: el conteo del límite y el chequeo de envíos en curso no tienen carrera.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`outbound:${target.channelId}`}, 0))`,
    );

    const [row] = await tx
      .select({
        status: outboundMessages.status,
        body: outboundMessages.body,
        conversationId: outboundMessages.conversationId,
        claimedAt: outboundMessages.claimedAt,
        stuck: sql<boolean>`${outboundMessages.claimedAt} <= now() - make_interval(secs => ${STUCK_SENDING_AFTER_MS / 1000})`,
      })
      .from(outboundMessages)
      .where(eq(outboundMessages.id, job.outboundId));
    if (!row) return { kind: 'done', result: 'sin_cambios', reason: 'not_found' };

    if (row.status === 'sending') {
      // Ya se reclamó (trabajo reintentado o vencido después del claim): nunca se reenvía.
      if (row.stuck) {
        await this.markUnknown(tx, [job.outboundId]);
        return { kind: 'done', result: 'fallido', reason: 'stuck_sending' };
      }
      return {
        kind: 'reschedule',
        conversationId: row.conversationId,
        startAfter: new Date(row.claimedAt!.getTime() + STUCK_SENDING_AFTER_MS + 1_000),
        reason: 'already_sending',
      };
    }
    if (row.status !== 'queued')
      return { kind: 'done', result: 'sin_cambios', reason: `status_${row.status}` };

    // Las reglas pueden haber cambiado mientras el trabajo esperaba en la cola.
    const context = await loadSendContext(tx, row.conversationId);
    if (!context) return { kind: 'done', result: 'sin_cambios', reason: 'no_conversation' };
    if (context.rejectReason) {
      await tx
        .update(outboundMessages)
        .set({ status: 'rejected', rejectReason: context.rejectReason })
        .where(and(eq(outboundMessages.id, job.outboundId), eq(outboundMessages.status, 'queued')));
      return { kind: 'done', result: 'rechazado', reason: context.rejectReason };
    }

    // Otro envío del mismo chat en curso (la cola ya evita dos activos por chat; esto cubre un trabajo
    // vencido o un proceso caído).
    const busy = await tx
      .select({
        id: outboundMessages.id,
        stuck: sql<boolean>`${outboundMessages.claimedAt} <= now() - make_interval(secs => ${STUCK_SENDING_AFTER_MS / 1000})`,
      })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.conversationId, row.conversationId),
          eq(outboundMessages.status, 'sending'),
          ne(outboundMessages.id, job.outboundId),
        ),
      );
    const stuck = busy.filter((other) => other.stuck).map((other) => other.id);
    if (stuck.length > 0) await this.markUnknown(tx, stuck);
    const now = await dbNow(tx);
    if (busy.length > stuck.length) {
      return {
        kind: 'reschedule',
        conversationId: row.conversationId,
        startAfter: new Date(now.getTime() + BUSY_CHAT_RETRY_MS),
        reason: 'chat_busy',
      };
    }

    // Límite del canal: claims del último minuto, salgan o no (incluye 'sending').
    const rate = await tx.execute<{ count: number; oldest: Date | string | null }>(sql`
      SELECT count(*)::int AS count, min(claimed_at) AS oldest FROM outbound_messages
      WHERE channel_id = ${context.channelId}
        AND claimed_at > now() - make_interval(secs => ${RATE_WINDOW_MS / 1000})
    `);
    const { count, oldest } = rate.rows[0]!;
    if (count >= MAX_SENDS_PER_MINUTE_PER_CHANNEL && oldest) {
      return {
        kind: 'reschedule',
        conversationId: row.conversationId,
        startAfter: new Date(new Date(oldest).getTime() + RATE_WINDOW_MS + 1_000),
        reason: 'channel_rate_limit',
      };
    }

    // Separación con el saliente anterior del chat, si no hubo un entrante en el medio.
    const gapMs = job.gapMs ?? sameChatGapMs(this.timing.random);
    const [previous] = await tx
      .select({ claimedAt: sql<Date | string | null>`max(${outboundMessages.claimedAt})` })
      .from(outboundMessages)
      .where(
        and(eq(outboundMessages.conversationId, row.conversationId), ne(outboundMessages.id, job.outboundId)),
      );
    const previousAt = previous?.claimedAt ? new Date(previous.claimedAt) : null;
    if (
      previousAt &&
      (!context.lastInboundAt || previousAt > context.lastInboundAt) &&
      now.getTime() - previousAt.getTime() < gapMs
    ) {
      return {
        kind: 'reschedule',
        conversationId: row.conversationId,
        startAfter: new Date(previousAt.getTime() + gapMs),
        gapMs,
        reason: 'same_chat_gap',
      };
    }

    const claimed = await tx
      .update(outboundMessages)
      .set({ status: 'sending', claimedAt: sql`now()`, attempts: sql`${outboundMessages.attempts} + 1` })
      .where(and(eq(outboundMessages.id, job.outboundId), eq(outboundMessages.status, 'queued')))
      .returning({ id: outboundMessages.id });
    if (claimed.length === 0) return { kind: 'done', result: 'sin_cambios', reason: 'claim_lost' };
    return { kind: 'send', context, body: row.body, unread: await unreadInbound(tx, row.conversationId) };
  }

  /**
   * Visto → escribiendo → espera → dejar de escribir → enviar. Solo session_down y blocked_risk cortan.
   * Si el chat ya mostraba "escribiendo…" desde typingSince (la IA pensando), ese tiempo se descuenta de
   * la espera: la secuencia es la misma, solo que empezó antes. El visto y el escribiendo se repiten igual
   * (el indicador de WhatsApp vence solo y puede haber entrantes nuevos sin marcar).
   */
  private async deliver(
    provider: WhatsAppProvider,
    target: ChatTarget,
    body: string,
    unread: SeenMessage[],
    log: Record<string, unknown>,
    typingSince: Date | null,
  ): Promise<SendResult> {
    const presence = async (step: string, call: Promise<PresenceResult>): Promise<ProviderFailure | null> => {
      const result = await call;
      if (result.ok) return null;
      this.logger.warn({ ...log, step, error: result.error, code: result.code, result: 'presencia_fallida' });
      // Sesión caída o riesgo de bloqueo: no se manda (lo registra recordFailure). Lo demás no frena.
      return result.error === 'session_down' || result.error === 'blocked_risk' ? result : null;
    };
    const down =
      (await presence('mark_seen', provider.markSeen({ ...target, messages: unread }))) ??
      (await presence('start_typing', provider.startTyping(target)));
    if (down) return down;
    // Solo si el indicador sigue a la vista (WhatsApp lo saca solo): si no, la demora completa.
    const elapsed = typingSince ? Date.now() - typingSince.getTime() : Infinity;
    const alreadyTyping = elapsed >= 0 && elapsed <= TYPING_INDICATOR_MAX_MS ? elapsed : 0;
    await this.timing.sleep(Math.max(0, typingDelayMs(body, this.timing.random) - alreadyTyping));
    const downAfterTyping = await presence('stop_typing', provider.stopTyping(target));
    if (downAfterTyping) return downAfterTyping;
    return provider.sendText({ ...target, text: body });
  }

  /** T2 (salió): outbox sent, mensaje en messages y enlace. */
  private async recordSent(
    tx: AppTx,
    job: OutboundJob,
    context: SendContext,
    body: string,
    result: Extract<SendResult, { ok: true }>,
  ): Promise<OutboundOutcome> {
    const [outbox] = await tx
      .update(outboundMessages)
      .set({ status: 'sent', externalId: result.externalId, lastError: null })
      .where(
        and(eq(outboundMessages.id, job.outboundId), inArray(outboundMessages.status, ['sending', 'failed'])),
      )
      .returning({
        tenantId: outboundMessages.tenantId,
        senderType: outboundMessages.senderType,
        sentByUserId: outboundMessages.sentByUserId,
      });
    if (!outbox) return 'sin_cambios';

    const sentAt = new Date(result.sentAt);
    const [inserted] = await tx
      .insert(messages)
      .values({
        tenantId: outbox.tenantId,
        conversationId: context.conversationId,
        channelId: context.channelId,
        externalId: result.externalId,
        direction: 'outbound',
        senderType: outbox.senderType,
        sentByUserId: outbox.sentByUserId,
        type: 'text',
        body,
        status: 'sent',
        // No hay payload de un webhook: se guarda de dónde salió (sin datos del contacto).
        raw: { source: 'outbound', outboundId: job.outboundId },
        sentAt,
      })
      .onConflictDoNothing({ target: [messages.channelId, messages.externalId] })
      .returning({ id: messages.id });
    const messageId =
      inserted?.id ??
      (
        await tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.channelId, context.channelId),
              eq(messages.externalId, result.externalId),
              // Un mensaje con ese id en otra conversación no se enlaza (la FK lo exige y no es este).
              eq(messages.conversationId, context.conversationId),
            ),
          )
      )[0]?.id;
    if (messageId) {
      await tx.update(outboundMessages).set({ messageId }).where(eq(outboundMessages.id, job.outboundId));
    }
    await tx
      .update(conversations)
      .set({ lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${sentAt})` })
      .where(eq(conversations.id, context.conversationId));
    return 'enviado';
  }

  /** T2 (no salió o no se sabe). */
  private async recordFailure(
    tx: AppTx,
    job: OutboundJob,
    context: SendContext,
    failure: ProviderFailure,
    final: boolean,
  ): Promise<OutboundOutcome> {
    const retry = (failure.error === 'transient' || failure.error === 'rate_limited') && !final;
    await tx
      .update(outboundMessages)
      .set({ status: retry ? 'queued' : 'failed', lastError: failure.error })
      .where(and(eq(outboundMessages.id, job.outboundId), eq(outboundMessages.status, 'sending')));

    await applyChannelFailure(tx, context.channelId, failure);
    return retry ? 'reintento' : 'fallido';
  }

  private async markUnknown(tx: AppTx, ids: string[]): Promise<void> {
    await tx
      .update(outboundMessages)
      .set({ status: 'failed', lastError: 'unknown_outcome' })
      .where(and(inArray(outboundMessages.id, ids), eq(outboundMessages.status, 'sending')));
  }
}

// Entrantes que todavía no vio nadie: los posteriores al último saliente del chat (los entrantes no
// guardan si se leyeron). Tope de 20: el visto marca todo el chat igual con los más recientes.
async function dbNow(tx: AppTx): Promise<Date> {
  const result = await tx.execute<{ now: Date | string }>(sql`SELECT now() AS now`);
  return new Date(result.rows[0]!.now);
}
