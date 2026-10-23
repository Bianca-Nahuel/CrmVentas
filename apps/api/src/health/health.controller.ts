import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { APP_DB, type AppDatabase } from '../db/database.module.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(APP_DB) private readonly database: AppDatabase) {}

  // Público y sin datos: solo comprueba que el pool de ventas_app responde (no lee tablas).
  @Public()
  @Get()
  async check() {
    try {
      await this.database.pool.query('SELECT 1');
      return { status: 'ok', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'unreachable' });
    }
  }
}
