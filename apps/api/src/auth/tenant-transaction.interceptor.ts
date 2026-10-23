import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { APP_DB, type AppDatabase } from '../db/database.module.js';
import { runInRequestScope, setDbContext } from '../db/tenant-context.js';
import type { AuthenticatedRequest } from './request.js';

// Cada request autenticado corre en UNA transacción de ventas_app con SET LOCAL app.user_id y
// (si hay empresa) app.tenant_id. El handler la obtiene con currentTx(). Si el handler falla,
// se hace rollback.
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(@Inject(APP_DB) private readonly database: AppDatabase) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = request.authSession;
    if (!session) return next.handle(); // endpoint público: sin contexto ni transacción

    const tenantContext = request.tenantContext ?? null;
    return from(
      this.database.db.transaction(async (tx) => {
        await setDbContext(tx, { userId: session.user.id, tenantId: tenantContext?.tenantId ?? null });
        return runInRequestScope({ tx, context: tenantContext }, () =>
          lastValueFrom(next.handle(), { defaultValue: undefined }),
        );
      }),
    );
  }
}
