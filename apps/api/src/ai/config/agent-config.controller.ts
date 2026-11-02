import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { TenantPermission } from '@ventas/shared';
import { NoTransaction, RequirePermission } from '../../auth/decorators.js';
import type { AuthenticatedRequest } from '../../auth/request.js';
import { currentTenantContext, currentTx } from '../../db/tenant-context.js';
import { ZodValidationPipe } from '../../http/zod-validation.pipe.js';
import {
  playgroundBodySchema,
  restoreBodySchema,
  saveAgentConfigBodySchema,
  versionParamsSchema,
  type PlaygroundBody,
  type RestoreBody,
  type SaveAgentConfigBody,
} from './agent-config.contracts.js';
import { AgentConfigService } from './agent-config.service.js';
import { PlaygroundService } from './playground.service.js';

// Rutas y esquemas: agent-config.contracts.ts. Todo con config.update (owner y admin); activar la revisión de
// calidad lo controla además AgentConfigService (solo el owner). El playground va con @NoTransaction: el
// modelo tarda segundos y el servicio abre sus transacciones cortas.
const UPDATE: TenantPermission = { config: ['update'] };
const versionParam = new ZodValidationPipe(versionParamsSchema, { notFound: true });

@Controller('agent-config')
export class AgentConfigController {
  constructor(
    private readonly configs: AgentConfigService,
    private readonly playground: PlaygroundService,
  ) {}

  @RequirePermission(UPDATE)
  @Get()
  current() {
    return this.configs.current(currentTx());
  }

  @RequirePermission(UPDATE)
  @Put()
  save(@Body(new ZodValidationPipe(saveAgentConfigBodySchema)) body: SaveAgentConfigBody) {
    return this.configs.save(currentTx(), currentTenantContext(), body);
  }

  @RequirePermission(UPDATE)
  @Get('versions')
  versions() {
    return this.configs.versions(currentTx());
  }

  @RequirePermission(UPDATE)
  @Get('versions/:version')
  version(@Param(versionParam) params: { version: number }) {
    return this.configs.version(currentTx(), params.version);
  }

  @RequirePermission(UPDATE)
  @HttpCode(200)
  @Post('versions/:version/restore')
  restore(
    @Param(versionParam) params: { version: number },
    @Body(new ZodValidationPipe(restoreBodySchema)) body: RestoreBody,
  ) {
    return this.configs.restore(currentTx(), currentTenantContext(), params.version, body);
  }

  @RequirePermission(UPDATE)
  @Get('models')
  models() {
    return this.configs.models(currentTx());
  }

  @RequirePermission(UPDATE)
  @NoTransaction()
  @HttpCode(200)
  @Post('playground')
  turn(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(playgroundBodySchema)) body: PlaygroundBody,
  ) {
    return this.playground.turn(request.tenantContext!, body);
  }
}
