import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq } from 'drizzle-orm';
import { APP_DB, type AppDatabase } from '../db/database.module.js';
import { memberships, tenants } from '../db/schema/auth.js';
import { setDbContext } from '../db/tenant-context.js';
import type { Auth } from './auth.js';
import { NO_TENANT_KEY, PUBLIC_KEY } from './decorators.js';
import type { AuthenticatedRequest } from './request.js';

// Guard global. Orden: sesión (401) → empresa activa (403) → membresía activa en esa empresa (403).
// La membresía se lee como ventas_app, con RLS, en una transacción corta con el contexto seteado.
// La transacción del request la abre después TenantTransactionInterceptor (un guard no puede
// envolver la ejecución del handler).
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService<Auth>,
    @Inject(APP_DB) private readonly database: AppDatabase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    if (context.getType() !== 'http') throw new UnauthorizedException();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.authService.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) throw new UnauthorizedException();
    request.authSession = session;

    if (this.reflector.getAllAndOverride<boolean>(NO_TENANT_KEY, targets)) return true;

    const userId = session.user.id;
    const tenantId = session.session.activeOrganizationId;
    if (!tenantId) throw new ForbiddenException({ code: 'NO_ACTIVE_TENANT' });

    const [membership] = await this.database.db.transaction(async (tx) => {
      await setDbContext(tx, { userId, tenantId });
      return tx
        .select({ role: memberships.role, status: memberships.status, tenantStatus: tenants.status })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
        .limit(1);
    });

    if (!membership || membership.status !== 'active') {
      throw new ForbiddenException({ code: 'MEMBERSHIP_INACTIVE' });
    }
    if (membership.tenantStatus !== 'active') throw new ForbiddenException({ code: 'TENANT_SUSPENDED' });

    request.tenantContext = { userId, tenantId, role: membership.role };
    return true;
  }
}
