// Contratos HTTP del panel de catálogo (tarea 027). Mismo esquema que inbox.contracts.ts: validan los
// controllers y arman el OpenAPI del que el panel genera su cliente. Todo con catalog.update (owner y admin),
// también lo que solo lee: el seller conserva catalog.read para otras cosas, pero acá recibe 403.
import { CATALOG_UNITS } from '@ventas/shared';
import { z } from 'zod';
import type { ApiRoute } from '../http/api-route.js';
import { IMPORT_FIELDS, SKU_PATTERN } from './import/normalize-rows.js';
import { EXTRACTOR_TEST_FIELDS } from './web/extractor-test.js';

const uuid = z.uuid();
const isoDate = z.iso.datetime({ offset: true });
const page = z.coerce.number().int().min(1).max(10_000).default(1);

/** Tope del archivo (el mismo del lector, DEFAULT_XLSX_LIMITS.maxFileBytes). */
export const CATALOG_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Filas de ejemplo que vuelven al subir el archivo. */
export const CATALOG_SAMPLE_ROWS = 10;
export const CATALOG_ROWS_PAGE_SIZE = 50;
export const CATALOG_PRODUCTS_PAGE_SIZE = 50;

const mappingColumnsSchema = z
  .object(
    Object.fromEntries(IMPORT_FIELDS.map((field) => [field, z.string().optional()])) as Record<
      (typeof IMPORT_FIELDS)[number],
      z.ZodOptional<z.ZodString>
    >,
  )
  .meta({ id: 'ImportMappingColumns' });

const importCountsShape = {
  rows: z.number().int(),
  invalid: z.number().int(),
  new: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int(),
  missing: z.number().int(),
  priceJumps: z.number().int(),
};
const importCountsSchema = z.object(importCountsShape).meta({ id: 'ImportCounts' });

export const importPreviewSchema = z
  .object({
    importId: uuid,
    fileName: z.string(),
    sheetName: z.string(),
    sheetNames: z.array(z.string()),
    // Fila de los encabezados (1 = la primera); null si no se encontró.
    headerRow: z.number().int().nullable(),
    headers: z.array(z.string()),
    // Primeras filas después de los encabezados, como texto, alineadas con headers.
    sample: z.array(z.array(z.string())),
    // null: no se reconocieron las columnas de código y nombre (hay que elegirlas).
    mapping: z.object({ columns: mappingColumnsSchema }).nullable(),
    mappingSource: z.enum(['argument', 'saved', 'proposed', 'none']),
    // Sin el componente ImportCounts: su nullable se le pasaría también al historial en el OpenAPI.
    counts: z.object(importCountsShape).nullable(),
    // SKUs activos que no están en el archivo (los primeros 50): se desactivan al aplicar.
    missing: z.array(z.string()),
    // Hasta cuándo se puede rehacer la vista previa sin volver a subir el archivo.
    fileExpiresAt: isoDate.nullable(),
  })
  .meta({ id: 'ImportPreview' });
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const importParamsSchema = z.object({ id: uuid }).strict();

export const rePreviewBodySchema = z
  .object({
    // Lo valida mappingSchema (normalize-rows.ts) en el servicio, con los mensajes del importador.
    mapping: z.object({
      sheet: z.string().max(100).optional(),
      header_row: z.number().int().optional(),
      columns: z.record(z.string(), z.string()),
    }),
  })
  .strict()
  .meta({ id: 'RePreviewImport' });
export type RePreviewBody = z.infer<typeof rePreviewBodySchema>;

export const importRowsQuerySchema = z
  .object({
    change: z.enum(['new', 'changed', 'unchanged']).optional(),
    status: z.enum(['valid', 'invalid']).optional(),
    priceJump: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    page,
  })
  .strict();
export type ImportRowsQuery = z.infer<typeof importRowsQuerySchema>;

const fieldChangeSchema = z
  .object({ field: z.string(), before: z.string().nullable(), after: z.string().nullable() })
  .meta({ id: 'ImportFieldChange' });

export const importRowSchema = z
  .object({
    rowNumber: z.number().int(),
    sku: z.string().nullable(),
    name: z.string().nullable(),
    status: z.enum(['valid', 'invalid']),
    change: z.enum(['new', 'changed', 'unchanged']).nullable(),
    priceJump: z.boolean(),
    // Motivos en lenguaje claro ("el link no es del dominio configurado").
    errors: z.array(z.string()),
    fields: z.array(fieldChangeSchema),
  })
  .meta({ id: 'ImportRow' });

export const importRowListSchema = z
  .object({
    items: z.array(importRowSchema),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .meta({ id: 'ImportRowList' });

export const applyResultSchema = z
  .object({ upserted: z.number().int(), deactivated: z.number().int(), snapshots: z.number().int() })
  .meta({ id: 'ImportApplyResult' });

export const revertResultSchema = z
  .object({ revertedId: uuid, restoredId: uuid })
  .meta({ id: 'ImportRevertResult' });

const personSchema = z.object({ name: z.string() }).nullable();

export const importSummarySchema = z
  .object({
    id: uuid,
    fileName: z.string(),
    status: z.enum(['preview', 'applied', 'reverted', 'failed']),
    // La aplicada vigente (a la que se vuelve atrás desde la siguiente).
    current: z.boolean(),
    counts: importCountsSchema,
    createdBy: personSchema,
    createdAt: isoDate,
    appliedAt: isoDate.nullable(),
    revertedAt: isoDate.nullable(),
  })
  .meta({ id: 'ImportSummary' });

export const importListSchema = z
  .object({
    items: z.array(importSummarySchema),
    // Hay una importación anterior a la que volver.
    canRevert: z.boolean(),
  })
  .meta({ id: 'ImportList' });

export const productListQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    active: z.enum(['true', 'false', 'all']).default('true'),
    page,
  })
  .strict();
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

const priceSchema = z
  .object({
    listPrice: z.string().nullable(),
    promoPrice: z.string().nullable(),
    priceNoTaxes: z.string().nullable(),
    currency: z.string(),
    readAt: isoDate,
    source: z.enum(['web', 'excel']),
  })
  .meta({ id: 'ProductPrice' });

export const productSummarySchema = z
  .object({
    sku: z.string(),
    name: z.string(),
    category: z.string().nullable(),
    unit: z.enum(CATALOG_UNITS),
    url: z.string().nullable(),
    active: z.boolean(),
    // Último snapshot válido (web o Excel); null si nunca hubo uno.
    price: priceSchema.nullable(),
  })
  .meta({ id: 'ProductSummary' });

export const productListSchema = z
  .object({
    items: z.array(productSummarySchema),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .meta({ id: 'ProductList' });

export const productParamsSchema = z.object({ sku: z.string().regex(SKU_PATTERN) }).strict();

const snapshotSchema = z
  .object({
    id: uuid,
    source: z.enum(['web', 'excel']),
    readAt: isoDate,
    ok: z.boolean(),
    errorCode: z.string().nullable(),
    listPrice: z.string().nullable(),
    promoPrice: z.string().nullable(),
    priceNoTaxes: z.string().nullable(),
    currency: z.string(),
    availability: z.enum(['in_stock', 'out_of_stock', 'unknown']),
  })
  .meta({ id: 'ProductSnapshot' });

export const productDetailSchema = productSummarySchema
  .extend({
    unitsPerPackage: z.string().nullable(),
    piecesPerPackage: z.number().int().nullable(),
    attributes: z.array(z.object({ key: z.string(), value: z.string() })),
    // Los últimos 10, del más nuevo al más viejo.
    snapshots: z.array(snapshotSchema),
  })
  .meta({ id: 'ProductDetail' });

export const refreshResultSchema = z
  .object({
    // Se leyó la página en este pedido (false: la lectura válida de la caché sigue vigente o se reintentó hace poco).
    fetched: z.boolean(),
    errorCode: z.string().nullable(),
    product: productDetailSchema,
  })
  .meta({ id: 'ProductRefreshResult' });

export const extractorTestBodySchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    // Sección catalog en edición (sin guardar). Sin ella, la vigente. La valida catalogConfigSchema.
    catalog: z.unknown().optional(),
  })
  .strict()
  .meta({ id: 'ExtractorTest' });
export type ExtractorTestBody = z.infer<typeof extractorTestBodySchema>;

export const extractorTestResultSchema = z
  .object({
    ok: z.boolean(),
    // Si no se pudo leer: url_domain, url_not_https, ip_not_public, http_status, timeout…
    errorCode: z.string().nullable(),
    httpStatus: z.number().int().nullable(),
    finalUrl: z.string().nullable(),
    title: z.string().nullable(),
    fields: z.array(
      z.object({
        field: z.enum(EXTRACTOR_TEST_FIELDS),
        value: z.string().nullable(),
        source: z.enum(['jsonld', 'microdata', 'meta', 'extractor']).nullable(),
        matched: z.string().nullable(),
      }),
    ),
    ruleIssues: z.array(z.string()),
    sanity: z.object({ ok: z.boolean(), errorCode: z.string().nullable(), dropped: z.array(z.string()) }),
    noAvailability: z.boolean(),
  })
  .meta({ id: 'ExtractorTestResult' });

export const catalogAdminRoutes: ApiRoute[] = [
  {
    method: 'post',
    path: '/catalog/imports',
    operationId: 'uploadCatalogImport',
    summary: 'Sube un .xlsx (hasta 5 MB) y arma la vista previa con el mapeo guardado o el propuesto',
    multipartFile: true,
    response: importPreviewSchema,
    conflict: true,
    errors: [413, 429],
  },
  {
    method: 'post',
    path: '/catalog/imports/{id}/preview',
    operationId: 'rePreviewCatalogImport',
    summary: 'Rehace la vista previa con otro mapeo, con el archivo guardado (sin volver a subirlo)',
    params: importParamsSchema,
    body: rePreviewBodySchema,
    response: importPreviewSchema,
    conflict: true,
    errors: [410],
  },
  {
    method: 'get',
    path: '/catalog/imports/{id}/rows',
    operationId: 'listCatalogImportRows',
    summary: 'Filas de la vista previa, paginadas, con qué cambió y los errores',
    params: importParamsSchema,
    query: importRowsQuerySchema,
    response: importRowListSchema,
  },
  {
    method: 'post',
    path: '/catalog/imports/{id}/apply',
    operationId: 'applyCatalogImport',
    summary: 'Aplica la vista previa (409 stale_preview si se aplicó otra en el medio)',
    params: importParamsSchema,
    response: applyResultSchema,
    conflict: true,
  },
  {
    method: 'post',
    path: '/catalog/imports/revert',
    operationId: 'revertCatalogImport',
    summary: 'Vuelve a la importación aplicada anterior',
    response: revertResultSchema,
    conflict: true,
  },
  {
    method: 'get',
    path: '/catalog/imports',
    operationId: 'listCatalogImports',
    summary: 'Historial de importaciones (las últimas 50)',
    response: importListSchema,
  },
  {
    method: 'get',
    path: '/catalog/products',
    operationId: 'listCatalogProducts',
    summary: 'Productos con su último precio válido',
    query: productListQuerySchema,
    response: productListSchema,
  },
  {
    method: 'get',
    path: '/catalog/products/{sku}',
    operationId: 'getCatalogProduct',
    summary: 'Un producto con sus atributos y sus últimas lecturas',
    params: productParamsSchema,
    response: productDetailSchema,
  },
  {
    method: 'post',
    path: '/catalog/products/{sku}/refresh',
    operationId: 'refreshCatalogProduct',
    summary: 'Lee la página del producto ahora (10 por minuto por usuario)',
    params: productParamsSchema,
    response: refreshResultSchema,
    conflict: true,
    errors: [429],
  },
  {
    method: 'post',
    path: '/catalog/extractor/test',
    operationId: 'testCatalogExtractor',
    summary: 'Prueba el extractor (el vigente o uno en edición) contra una URL; nunca devuelve el HTML',
    body: extractorTestBodySchema,
    response: extractorTestResultSchema,
    conflict: true,
    errors: [429],
  },
];
