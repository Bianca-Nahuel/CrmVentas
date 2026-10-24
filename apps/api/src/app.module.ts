import { Module } from '@nestjs/common';
import { AppAuthModule } from './auth/app-auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './db/database.module.js';
import { HealthController } from './health/health.controller.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MeController } from './me/me.controller.js';
import { InboundModule } from './whatsapp/inbound/inbound.module.js';
import { WhatsappModule } from './whatsapp/whatsapp.module.js';

@Module({
  imports: [ConfigModule, DatabaseModule, AppAuthModule, JobsModule, WhatsappModule, InboundModule],
  controllers: [HealthController, MeController],
})
export class AppModule {}
