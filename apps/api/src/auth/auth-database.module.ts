import { Inject, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { assertRestrictedRole, createAuthDatabase, type AuthDb, type Database } from '../db/pools.js';

/** Base de Better Auth (ventas_auth). NO es global: solo la importa AppAuthModule. */
export const AUTH_DB = Symbol('AUTH_DB');
export type AuthDatabase = Database<AuthDb>;

@Module({
  providers: [
    {
      provide: AUTH_DB,
      inject: [ENV],
      useFactory: (env: Env): AuthDatabase => createAuthDatabase(env.DATABASE_URL_AUTH),
    },
  ],
  exports: [AUTH_DB],
})
export class AuthDatabaseModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(AUTH_DB) private readonly database: AuthDatabase) {}

  async onModuleInit(): Promise<void> {
    await assertRestrictedRole(this.database.pool, 'DATABASE_URL_AUTH');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
  }
}
