import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../auth/decorators.js';
import { currentTenantContext, currentTx } from '../db/tenant-context.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import {
  digestListQuerySchema,
  disputeBodySchema,
  reviewListQuerySchema,
  reviewParamsSchema,
  weeklyQuerySchema,
  type ReviewListQuery,
  type WeeklyQuery,
} from './performance.contracts.js';
import { PerformanceService } from './performance.service.js';

// Rutas y esquemas: performance.contracts.ts. performance.read: owner, admin y viewer (los totales por
// número); performance.read_detail: owner y admin (vendedores y revisiones). El seller no entra.
const reviewIdParam = new ZodValidationPipe(reviewParamsSchema, { notFound: true });

@Controller('performance')
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @RequirePermission({ performance: ['read'] })
  @Get('weekly')
  weekly(@Query(new ZodValidationPipe(weeklyQuerySchema)) query: WeeklyQuery) {
    return this.performance.weekly(currentTx(), currentTenantContext(), query);
  }

  @RequirePermission({ performance: ['read_detail'] })
  @Get('reviews')
  listReviews(@Query(new ZodValidationPipe(reviewListQuerySchema)) query: ReviewListQuery) {
    return this.performance.listReviews(currentTx(), query);
  }

  @RequirePermission({ performance: ['read_detail'] })
  @Get('reviews/:id')
  getReview(@Param(reviewIdParam) params: { id: string }) {
    return this.performance.getReview(currentTx(), params.id);
  }

  @RequirePermission({ performance: ['read_detail'] })
  @HttpCode(200)
  @Post('reviews/:id/dispute')
  dispute(
    @Param(reviewIdParam) params: { id: string },
    @Body(new ZodValidationPipe(disputeBodySchema)) body: { note?: string },
  ) {
    return this.performance.dispute(currentTx(), currentTenantContext(), params.id, body.note);
  }

  @RequirePermission({ performance: ['read_detail'] })
  @Get('digests')
  digests(
    @Query(new ZodValidationPipe(digestListQuerySchema))
    query: {
      channelId?: string;
      from?: string;
      to?: string;
    },
  ) {
    return this.performance.digests(currentTx(), query);
  }
}
