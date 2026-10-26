import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import { errorCode } from '../../jobs/error-code.js';
import { BOSS, QUEUES } from '../../jobs/jobs.module.js';
import type { JobAttempt } from '../../whatsapp/inbound/inbound.worker.js';
import type { AiReplyJob } from './ai-reply.job.js';
import { AiReplyService } from './ai-reply.service.js';

const WORK_OPTIONS = { localConcurrency: 4, pollingIntervalSeconds: 1, includeMetadata: true } as const;

// Worker de ai-reply. Una excepción (base caída) hace que pg-boss reintente; los errores del modelo los
// resuelve AiReplyService (quedan en ai_runs como error:<tipo>). Logs sin texto ni datos personales.
@Injectable()
export class AiReplyWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger('AiReplyWorker');

  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    private readonly service: AiReplyService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work<AiReplyJob, unknown, typeof WORK_OPTIONS>(
      QUEUES.aiReply,
      WORK_OPTIONS,
      async (jobs) => {
        for (const job of jobs) await this.handle(job.data, job);
      },
    );
  }

  async handle(job: AiReplyJob, attempt: JobAttempt): Promise<void> {
    try {
      const outcome = await this.service.process(job);
      if (outcome.decision.startsWith('skipped:')) {
        this.logger.log({
          msg: 'ai-reply',
          jobId: attempt.id,
          conversationId: job.conversationId,
          decision: outcome.decision,
        });
      }
    } catch (error) {
      const final = attempt.retryCount >= attempt.retryLimit;
      const code = errorCode(error);
      this.logger[final ? 'error' : 'warn']({
        msg: 'ai-reply',
        jobId: attempt.id,
        retryCount: attempt.retryCount,
        code,
        result: final ? 'fallido' : 'reintento',
      });
      // Sin cause: los errores de Drizzle traen la consulta con sus parámetros (texto, datos).
      // eslint-disable-next-line preserve-caught-error -- sin cause a propósito
      throw new Error(`Falló la corrida de la IA (código ${code})`);
    }
  }
}
