import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { rawWebhookBody } from '../http/webhook-body.js';
import { WHATSAPP_PROVIDER_REGISTRY, type WhatsAppProviderRegistry } from './provider.js';
import { WahaClient } from './providers/waha/waha-client.js';
import { WahaWebhookController } from './providers/waha/waha-webhook.controller.js';
import { WahaProvider } from './providers/waha/waha.provider.js';

/** Proveedores de WhatsApp y sus webhooks. */
@Module({
  controllers: [WahaWebhookController],
  providers: [
    {
      provide: WahaClient,
      inject: [ENV],
      useFactory: (env: Env) => new WahaClient(env.WAHA_BASE_URL, env.WAHA_API_KEY),
    },
    {
      provide: WHATSAPP_PROVIDER_REGISTRY,
      inject: [WahaClient],
      useFactory: (waha: WahaClient): WhatsAppProviderRegistry => new Map([['waha', new WahaProvider(waha)]]),
    },
  ],
  exports: [WHATSAPP_PROVIDER_REGISTRY],
})
export class WhatsappModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Cuerpo crudo solo para el webhook (la firma se calcula sobre esos bytes).
    consumer.apply(rawWebhookBody).forRoutes({ path: 'webhooks/waha', method: RequestMethod.POST });
  }
}
