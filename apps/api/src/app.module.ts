import { Module } from '@nestjs/common';
import { AppAuthModule } from './auth/app-auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './db/database.module.js';
import { HealthController } from './health/health.controller.js';
import { MeController } from './me/me.controller.js';

@Module({
  imports: [ConfigModule, DatabaseModule, AppAuthModule],
  controllers: [HealthController, MeController],
})
export class AppModule {}
