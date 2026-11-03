import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermission } from '../auth/decorators.js';
import { currentTenantContext, currentTx } from '../db/tenant-context.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import {
  funnelLeadsQuerySchema,
  funnelQuerySchema,
  stalledQuerySchema,
  type FunnelLeadsQuery,
  type FunnelQuery,
  type StalledQuery,
} from './funnel.contracts.js';
import { FunnelService } from './funnel.service.js';

// Rutas y esquemas: funnel.contracts.ts. El embudo pide metrics.read (owner, admin y viewer). Las listas
// muestran contactos y mensajes: además piden lead.read, que el viewer no tiene (#106).
@Controller('funnel')
export class FunnelController {
  constructor(private readonly funnel: FunnelService) {}

  @RequirePermission({ metrics: ['read'] })
  @Get()
  get(@Query(new ZodValidationPipe(funnelQuerySchema)) query: FunnelQuery) {
    return this.funnel.funnel(currentTx(), currentTenantContext(), query);
  }

  @RequirePermission({ metrics: ['read'], lead: ['read'] })
  @Get('leads')
  leads(@Query(new ZodValidationPipe(funnelLeadsQuerySchema)) query: FunnelLeadsQuery) {
    return this.funnel.leads(currentTx(), currentTenantContext(), query);
  }

  @RequirePermission({ metrics: ['read'], lead: ['read'] })
  @Get('stalled')
  stalled(@Query(new ZodValidationPipe(stalledQuerySchema)) query: StalledQuery) {
    return this.funnel.stalled(currentTx(), currentTenantContext(), query);
  }
}
