import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module.js';
import { AppAuthModule } from './auth/app-auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './db/database.module.js';
import { HealthController } from './health/health.controller.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MeController } from './me/me.controller.js';
import { OutboundModule } from './messaging/outbound/outbound.module.js';
import { InboundModule } from './whatsapp/inbound/inbound.module.js';
import { WhatsappModule } from './whatsapp/whatsapp.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AppAuthModule,
    JobsModule,
    WhatsappModule,
    InboundModule,
    OutboundModule,
    AiModule,
  ],
  controllers: [HealthController, MeController],
})
export class AppModule {}
