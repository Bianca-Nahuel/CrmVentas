import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PgBoss } from 'pg-boss';
import { NoTenant, Public } from '../../../auth/decorators.js';
import { ENV } from '../../../config/config.module.js';
import type { Env } from '../../../config/env.js';
import { stripNulChars } from '../../../http/webhook-body.js';
import { BOSS, QUEUES } from '../../../jobs/jobs.module.js';
import type { InboundJob } from '../../inbound/inbound-job.js';
import { WAHA_PROCESSED_EVENTS, wahaEnvelopeSchema } from './waha-normalize.js';
import { verifyWahaSignature } from './waha-signature.js';

// POST /api/webhooks/waha. Sin sesión ni empresa: no abre la transacción del request ni toca tablas
// de negocio. Autentica con la firma HMAC, valida la forma mínima, encola y responde 200 sin esperar
// el procesamiento (lo hace el worker de whatsapp-inbound).
// El cuerpo llega crudo (Buffer) por el middleware de WhatsappModule; ver http/webhook-body.ts.
@Controller('webhooks')
export class WahaWebhookController {
  private readonly logger = new Logger('WahaWebhook');

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

  @Post('waha')
  @Public()
  @NoTenant()
  @HttpCode(200)
  async receive(@Req() request: Request): Promise<{ ok: true }> {
    const raw: unknown = request.body;
    const signed =
      Buffer.isBuffer(raw) &&
      verifyWahaSignature(
        {
          hmac: request.headers['x-webhook-hmac'],
          algorithm: request.headers['x-webhook-hmac-algorithm'],
        },
        raw,
        this.env.WAHA_WEBHOOK_HMAC_KEY,
      );
    if (!signed) throw new UnauthorizedException();

    let body: unknown;
    try {
      // La firma ya se verificó sobre los bytes originales; lo que se encola va sin U+0000.
      body = stripNulChars(JSON.parse(raw.toString('utf8')));
    } catch {
      throw new BadRequestException();
    }
    const envelope = wahaEnvelopeSchema.safeParse(body);
    if (!envelope.success) throw new BadRequestException();

    const { id, event } = envelope.data;
    if (!WAHA_PROCESSED_EVENTS.has(event)) {
      this.logger.log({ msg: 'webhook', provider: 'waha', eventId: id, event, result: 'ignorado' });
      return { ok: true };
    }

    const job: InboundJob = { provider: 'waha', payload: body };
    await this.boss.send(QUEUES.whatsappInbound, job);
    this.logger.log({ msg: 'webhook', provider: 'waha', eventId: id, event, result: 'encolado' });
    return { ok: true };
  }
}
