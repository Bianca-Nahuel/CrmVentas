import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { NoTransaction, RequirePermission } from '../auth/decorators.js';
import type { AuthenticatedRequest } from '../auth/request.js';
import { RealtimeHub, STREAM_PERMISSION } from './realtime-hub.js';

/**
 * GET /api/events: stream SSE de la bandeja (ver events.contracts.ts). Pasa por TenantGuard (401 sin sesión,
 * 403 sin empresa activa, membresía o permiso) y queda afuera de la transacción del request (@NoTransaction):
 * mientras está abierto no ocupa ninguna conexión de la base.
 */
@Controller()
export class EventsController {
  constructor(@Inject(RealtimeHub) private readonly hub: RealtimeHub) {}

  @RequirePermission(STREAM_PERMISSION)
  @NoTransaction()
  @Get('events')
  async stream(@Req() request: AuthenticatedRequest, @Res() response: Response): Promise<void> {
    // 429 si el usuario o la instancia llegaron al límite de streams (lo decide el hub).
    await this.hub.open(request.authSession!, request.tenantContext!, request.headers.cookie ?? '', response);
  }
}
