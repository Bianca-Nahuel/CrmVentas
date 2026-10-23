import type { Request } from 'express';
import type { TenantContext } from '../db/tenant-context.js';
import type { Auth } from './auth.js';

export type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

export interface AuthenticatedRequest extends Request {
  authSession?: AuthSession;
  tenantContext?: TenantContext;
}
