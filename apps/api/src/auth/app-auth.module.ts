import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AUTH_DB, AuthDatabaseModule, type AuthDatabase } from './auth-database.module.js';
import { createAuth } from './auth.js';
import { TenantGuard } from './tenant.guard.js';
import { TenantTransactionInterceptor } from './tenant-transaction.interceptor.js';

// Better Auth se monta en /api/auth/* con @thallesp/nestjs-better-auth (maneja el body parser y el
// handler de Express). Su guard global queda desactivado: el único guard global es TenantGuard.
// Las rutas /api/auth/* no pasan por guards de Nest: sus reglas extra están en los hooks de auth.ts.
@Module({
  imports: [
    AuthModule.forRootAsync({
      isGlobal: true,
      disableGlobalAuthGuard: true,
      imports: [AuthDatabaseModule],
      inject: [ENV, AUTH_DB],
      useFactory: (env: Env, authDatabase: AuthDatabase) => ({
        auth: createAuth(env, authDatabase.db),
        bodyParser: { json: { limit: '1mb' }, urlencoded: { limit: '1mb', extended: false } },
      }),
    }),
  ],
  providers: [
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
  ],
})
export class AppAuthModule {}
