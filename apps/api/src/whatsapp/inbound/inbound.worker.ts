import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import { BOSS, QUEUES } from '../../jobs/jobs.module.js';
import { WHATSAPP_PROVIDER_REGISTRY, type WhatsAppProviderRegistry } from '../provider.js';
import { ECHO_RECHECK_DELAY_SECONDS } from '../../messaging/outbound/outbound.constants.js';
import type { InboundJob } from './inbound-job.js';
import { InboundService } from './inbound.service.js';

const WORK_OPTIONS = { localConcurrency: 2, pollingIntervalSeconds: 1, includeMetadata: true } as const;

/** Datos del intento que usa el worker (los da pg-boss con includeMetadata). */
export interface JobAttempt {
  id: string;
  retryCount: number;
  retryLimit: number;
}

// Worker de whatsapp-inbound. Corre en el proceso de la API (MVP); para moverlo a otro proceso basta
// con levantar InboundModule sin los controllers.
// Una excepción (base caída, WAHA sin responder al buscar un LID) hace que pg-boss reintente con
// backoff; lo que nunca va a poder procesarse (evento ignorado, canal desconocido) se completa con log.
// Logs: ids, tipo y resultado. Nunca teléfono, nombre ni texto.
@Injectable()
export class InboundWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger('InboundWorker');

  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(WHATSAPP_PROVIDER_REGISTRY) private readonly providers: WhatsAppProviderRegistry,
    private readonly inbound: InboundService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work<InboundJob, unknown, typeof WORK_OPTIONS>(
      QUEUES.whatsappInbound,
      WORK_OPTIONS,
      async (jobs) => {
        for (const job of jobs) await this.handle(job.data, job);
      },
    );
  }

  async handle(job: InboundJob, attempt: JobAttempt): Promise<void> {
    try {
      await this.process(job, attempt.id);
    } catch (error) {
      const final = attempt.retryCount >= attempt.retryLimit;
      const code = errorCode(error);
      this.logger[final ? 'error' : 'warn']({
        msg: 'inbound',
        jobId: attempt.id,
        retryCount: attempt.retryCount,
        code,
        result: final ? 'fallido' : 'reintento',
      });
      // pg-boss guarda el error en pgboss.job.output: los de Drizzle traen la consulta con sus
      // parámetros (teléfono, texto), así que se reemplazan por uno con solo el código.
      // eslint-disable-next-line preserve-caught-error -- sin cause a propósito: tiene los parámetros
      throw new Error(`Falló el procesamiento (código ${code})`);
    }
  }

  private async process(job: InboundJob, jobId: string): Promise<void> {
    const provider = this.providers.get(job.provider);
    if (!provider) {
      this.logger.warn({ msg: 'inbound', jobId, result: 'ignorado', reason: 'unknown_provider' });
      return;
    }

    const normalized = provider.normalize(job.payload);
    if (normalized.kind === 'ignored') {
      this.logger.log({
        msg: 'inbound',
        jobId,
        provider: provider.id,
        eventId: normalized.eventId,
        result: 'ignorado',
        reason: normalized.reason,
      });
      return;
    }

    // El canal primero: un evento de una sesión desconocida no llega a consultar al proveedor.
    const channel = await this.inbound.resolveChannel(normalized.event);
    const base = { msg: 'inbound', jobId, provider: provider.id, eventId: normalized.event.eventId };
    if (!channel) {
      this.logger.log({ ...base, type: normalized.event.type, result: 'descartado' });
      return;
    }

    const event = await provider.enrich(normalized.event);
    const echoAttempt = job.echoAttempt ?? 0;
    const result = await this.inbound.process(event, channel, echoAttempt);
    if (result === 'reprogramar') {
      // Eco con un envío en curso en el chat: se vuelve a mirar en unos segundos (trabajo nuevo, no un
      // reintento: no consume los reintentos por errores).
      await this.boss.send(
        QUEUES.whatsappInbound,
        { ...job, echoAttempt: echoAttempt + 1 } satisfies InboundJob,
        { startAfter: ECHO_RECHECK_DELAY_SECONDS },
      );
    }
    this.logger.log({
      ...base,
      channelId: channel.channelId,
      type: event.type,
      ...(event.type === 'message.received' || event.type === 'message.echo'
        ? { messageType: event.messageType }
        : {}),
      ...(event.type === 'message.status' ? { status: event.status } : {}),
      ...(result === 'reprogramar' ? { echoAttempt: echoAttempt + 1 } : {}),
      result,
    });
  }
}

// Código de Postgres (o de Node: ECONNREFUSED…) o, si no hay, el nombre del error (TimeoutError…).
// Identificadores sin datos personales; el mensaje nunca se usa.
function errorCode(error: unknown): string {
  const failure = error as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  for (const candidate of [failure?.cause?.code, failure?.code, failure?.name]) {
    if (typeof candidate === 'string' && /^[A-Z0-9_]{1,40}$/i.test(candidate)) return candidate;
  }
  return 'desconocido';
}
