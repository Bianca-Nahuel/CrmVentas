import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { catchError, throwError } from 'rxjs';
import type { TenantPermission } from '@ventas/shared';
import { NoTransaction, RequirePermission } from '../auth/decorators.js';
import type { AuthenticatedRequest } from '../auth/request.js';
import { currentTx } from '../db/tenant-context.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import {
  CATALOG_UPLOAD_MAX_BYTES,
  extractorTestBodySchema,
  importParamsSchema,
  importRowsQuerySchema,
  productListQuerySchema,
  productParamsSchema,
  rePreviewBodySchema,
  type ExtractorTestBody,
  type ImportRowsQuery,
  type ProductListQuery,
  type RePreviewBody,
} from './catalog-admin.contracts.js';
import { CatalogAdminService, type UploadedXlsx } from './catalog-admin.service.js';

// Rutas y esquemas: catalog-admin.contracts.ts. Todo con catalog.update (owner y admin). Lo que puede tardar
// (subir el archivo, leer una página) va con @NoTransaction: el servicio abre sus transacciones cortas.
const UPDATE: TenantPermission = { catalog: ['update'] };
const importIdParam = new ZodValidationPipe(importParamsSchema, { notFound: true });
const skuParam = new ZodValidationPipe(productParamsSchema, { notFound: true });

/** Margen del multipart (encabezados, separadores y el nombre del archivo) sobre el tope del archivo. */
const MULTIPART_OVERHEAD = 64 * 1024;

/**
 * Corta por el Content-Length declarado antes de leer el cuerpo. Sin Content-Length (chunked), corta multer
 * con su límite fileSize mientras lee: su 413 se devuelve con el mismo código.
 */
class DeclaredSizeLimit implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const declared = Number(
      context.switchToHttp().getRequest<AuthenticatedRequest>().headers['content-length'],
    );
    if (Number.isFinite(declared) && declared > CATALOG_UPLOAD_MAX_BYTES + MULTIPART_OVERHEAD) {
      throw new PayloadTooLargeException({ code: 'FILE_TOO_LARGE' });
    }
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() =>
            error instanceof PayloadTooLargeException
              ? new PayloadTooLargeException({ code: 'FILE_TOO_LARGE' })
              : error,
          ),
        ),
      );
  }
}

@Controller('catalog')
export class CatalogAdminController {
  constructor(private readonly admin: CatalogAdminService) {}

  @RequirePermission(UPDATE)
  @NoTransaction()
  @HttpCode(200)
  @Post('imports')
  @UseInterceptors(
    DeclaredSizeLimit,
    // En memoria, nunca en disco; un solo archivo y nada más en el formulario. El nombre del archivo en
    // UTF-8 (por defecto multer lo lee como latin1 y "catálogo.xlsx" queda roto).
    FileInterceptor('file', {
      storage: memoryStorage(),
      defParamCharset: 'utf8',
      limits: { fileSize: CATALOG_UPLOAD_MAX_BYTES, files: 1, fields: 0, parts: 1, headerPairs: 20 },
    }),
  )
  upload(@Req() request: AuthenticatedRequest, @UploadedFile() file: UploadedXlsx | undefined) {
    return this.admin.upload(request.tenantContext!, file);
  }

  @RequirePermission(UPDATE)
  @HttpCode(200)
  @Post('imports/revert')
  revert() {
    return this.admin.revert(currentTx());
  }

  @RequirePermission(UPDATE)
  @HttpCode(200)
  @Post('imports/:id/preview')
  rePreview(
    @Param(importIdParam) params: { id: string },
    @Body(new ZodValidationPipe(rePreviewBodySchema)) body: RePreviewBody,
  ) {
    return this.admin.rePreview(currentTx(), params.id, body.mapping);
  }

  @RequirePermission(UPDATE)
  @Get('imports/:id/rows')
  rows(
    @Param(importIdParam) params: { id: string },
    @Query(new ZodValidationPipe(importRowsQuerySchema)) query: ImportRowsQuery,
  ) {
    return this.admin.rows(currentTx(), params.id, query);
  }

  @RequirePermission(UPDATE)
  @HttpCode(200)
  @Post('imports/:id/apply')
  apply(@Param(importIdParam) params: { id: string }) {
    return this.admin.apply(currentTx(), params.id);
  }

  @RequirePermission(UPDATE)
  @Get('imports')
  listImports() {
    return this.admin.listImports(currentTx());
  }

  @RequirePermission(UPDATE)
  @Get('products')
  listProducts(@Query(new ZodValidationPipe(productListQuerySchema)) query: ProductListQuery) {
    return this.admin.listProducts(currentTx(), query);
  }

  @RequirePermission(UPDATE)
  @Get('products/:sku')
  product(@Param(skuParam) params: { sku: string }) {
    return this.admin.product(currentTx(), params.sku);
  }

  @RequirePermission(UPDATE)
  @NoTransaction()
  @HttpCode(200)
  @Post('products/:sku/refresh')
  refresh(@Req() request: AuthenticatedRequest, @Param(skuParam) params: { sku: string }) {
    return this.admin.refresh(request.tenantContext!, params.sku);
  }

  @RequirePermission(UPDATE)
  @NoTransaction()
  @HttpCode(200)
  @Post('extractor/test')
  testExtractor(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(extractorTestBodySchema)) body: ExtractorTestBody,
  ) {
    return this.admin.testExtractor(request.tenantContext!, body);
  }
}
