import { Global, Inject, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { assertRestrictedRole, createAppDatabase, type AppDb, type Database } from './pools.js';

/** Base del código de negocio (ventas_app, con RLS). */
export const APP_DB = Symbol('APP_DB');
export type AppDatabase = Database<AppDb>;

@Global()
@Module({
  providers: [
    {
      provide: APP_DB,
      inject: [ENV],
      useFactory: (env: Env): AppDatabase => createAppDatabase(env.DATABASE_URL),
    },
  ],
  exports: [APP_DB],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(APP_DB) private readonly database: AppDatabase) {}

  async onModuleInit(): Promise<void> {
    await assertRestrictedRole(this.database.pool, 'DATABASE_URL');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
  }
}
