// Catálogo de productos (tarea 007): productos importados del Excel, importaciones con sus filas (vista
// previa y volver atrás) y cada lectura de un producto (web o Excel). La columna de búsqueda (tsvector
// generado con unaccent), los índices GIN, las FKs con tenant_id, los permisos y la RLS están en la
// migración 0012 (SQL a mano).
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './auth.js';

export const catalogProducts = pgTable(
  'catalog_products',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    category: text('category'),
    unit: text('unit').notNull().default('unit'),
    // Por ejemplo, m² por caja.
    unitsPerPackage: numeric('units_per_package', { precision: 12, scale: 4 }),
    piecesPerPackage: integer('pieces_per_package'),
    url: text('url'),
    // Todas las demás columnas del Excel, con el encabezado normalizado como clave. Dato no confiable.
    attributes: jsonb('attributes').notNull().default({}),
    active: boolean('active').notNull().default(true),
    lastImportId: uuid('last_import_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('catalog_products_tenant_sku_unique').on(t.tenantId, t.sku),
    unique('catalog_products_tenant_id_unique').on(t.tenantId, t.id),
    index('catalog_products_tenant_active_idx').on(t.tenantId, t.active),
    check('catalog_products_sku_check', sql`${t.sku} ~ '^[A-Za-z0-9._/-]{1,64}$'`),
    check('catalog_products_name_check', sql`char_length(${t.name}) BETWEEN 1 AND 300`),
    check('catalog_products_category_check', sql`char_length(${t.category}) <= 120`),
    check('catalog_products_unit_check', sql`${t.unit} IN ('m2', 'ml', 'unit', 'box', 'kg', 'l')`),
    check('catalog_products_units_per_package_check', sql`${t.unitsPerPackage} > 0`),
    check('catalog_products_pieces_per_package_check', sql`${t.piecesPerPackage} > 0`),
    check(
      'catalog_products_url_check',
      // Solo ASCII imprimible: la URL se escribe tal cual en el mensaje al cliente (0013).
      sql`${t.url} ~ '^https://[!-~]+$' AND char_length(${t.url}) <= 2048`,
    ),
    check('catalog_products_attributes_check', sql`jsonb_typeof(${t.attributes}) = 'object'`),
  ],
);

// Una importación del Excel. preview → applied (o failed); una aplicada pasa a reverted al volver atrás.
export const catalogImports = pgTable(
  'catalog_imports',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    fileSha256: text('file_sha256').notNull(),
    fileSize: integer('file_size').notNull(),
    sheetName: text('sheet_name').notNull(),
    // Columnas del archivo → campos (sku, name, url…). Se reusa en la próxima importación.
    mapping: jsonb('mapping').notNull(),
    status: text('status').notNull().default('preview'),
    // La importación aplicada vigente cuando se armó la vista previa: si cambió, hay que rehacerla.
    baseImportId: uuid('base_import_id'),
    rowsTotal: integer('rows_total').notNull().default(0),
    rowsInvalid: integer('rows_invalid').notNull().default(0),
    newCount: integer('new_count').notNull().default(0),
    changedCount: integer('changed_count').notNull().default(0),
    unchangedCount: integer('unchanged_count').notNull().default(0),
    missingCount: integer('missing_count').notNull().default(0),
    priceJumpCount: integer('price_jump_count').notNull().default(0),
    errorCode: text('error_code'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
  },
  (t) => [
    unique('catalog_imports_tenant_id_unique').on(t.tenantId, t.id),
    index('catalog_imports_tenant_created_idx').on(t.tenantId, t.createdAt),
    check('catalog_imports_status_check', sql`${t.status} IN ('preview', 'applied', 'reverted', 'failed')`),
    check('catalog_imports_sha256_check', sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
    check('catalog_imports_file_name_check', sql`char_length(${t.fileName}) BETWEEN 1 AND 255`),
    check('catalog_imports_sheet_name_check', sql`char_length(${t.sheetName}) BETWEEN 1 AND 100`),
    check('catalog_imports_file_size_check', sql`${t.fileSize} > 0`),
    check('catalog_imports_mapping_check', sql`jsonb_typeof(${t.mapping}) = 'object'`),
    check(
      'catalog_imports_counts_check',
      sql`${t.rowsTotal} >= 0 AND ${t.rowsInvalid} >= 0 AND ${t.newCount} >= 0 AND ${t.changedCount} >= 0
        AND ${t.unchangedCount} >= 0 AND ${t.missingCount} >= 0 AND ${t.priceJumpCount} >= 0`,
    ),
    check('catalog_imports_error_code_check', sql`${t.errorCode} ~ '^[a-z_]{1,40}$'`),
  ],
);

// Filas de una importación ya normalizadas, con su validación. Historial: solo INSERT.
export const catalogImportRows = pgTable(
  'catalog_import_rows',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    importId: uuid('import_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    sku: text('sku'),
    data: jsonb('data').notNull(),
    status: text('status').notNull(),
    errors: jsonb('errors').notNull().default([]),
    change: text('change'),
    changedFields: jsonb('changed_fields').notNull().default([]),
    priceJump: boolean('price_jump').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('catalog_import_rows_import_row_unique').on(t.importId, t.rowNumber),
    index('catalog_import_rows_tenant_import_idx').on(t.tenantId, t.importId),
    check('catalog_import_rows_status_check', sql`${t.status} IN ('valid', 'invalid')`),
    check('catalog_import_rows_change_check', sql`${t.change} IN ('new', 'changed', 'unchanged')`),
    check('catalog_import_rows_row_number_check', sql`${t.rowNumber} > 0`),
    check('catalog_import_rows_data_check', sql`jsonb_typeof(${t.data}) = 'object'`),
    check('catalog_import_rows_errors_check', sql`jsonb_typeof(${t.errors}) = 'array'`),
  ],
);

// Cada lectura de un producto, de la web o del Excel. Solo de agregado: es el historial de precios.
export const productSnapshots = pgTable(
  'product_snapshots',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
    source: text('source').notNull(),
    importId: uuid('import_id'),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
    ok: boolean('ok').notNull(),
    errorCode: text('error_code'),
    listPrice: numeric('list_price', { precision: 14, scale: 2 }),
    promoPrice: numeric('promo_price', { precision: 14, scale: 2 }),
    promoCondition: text('promo_condition'),
    priceNoTaxes: numeric('price_no_taxes', { precision: 14, scale: 2 }),
    currency: text('currency').notNull().default('ARS'),
    priceUnit: text('price_unit'),
    unitsPerPackage: numeric('units_per_package', { precision: 12, scale: 4 }),
    piecesPerPackage: integer('pieces_per_package'),
    availability: text('availability').notNull().default('unknown'),
    description: text('description'),
    extra: jsonb('extra').notNull().default({}),
    // De dónde salió cada campo (jsonld, microdata, meta, extractor, excel).
    fieldSources: jsonb('field_sources').notNull().default({}),
    finalUrl: text('final_url'),
    httpStatus: smallint('http_status'),
  },
  (t) => [
    index('product_snapshots_product_read_idx').on(t.tenantId, t.productId, t.readAt),
    check('product_snapshots_source_check', sql`${t.source} IN ('web', 'excel')`),
    check('product_snapshots_error_code_check', sql`${t.errorCode} ~ '^[a-z_]{1,40}$'`),
    check('product_snapshots_ok_check', sql`${t.ok} OR ${t.errorCode} IS NOT NULL`),
    check(
      'product_snapshots_prices_check',
      sql`${t.listPrice} > 0 AND ${t.promoPrice} > 0 AND ${t.priceNoTaxes} > 0`,
    ),
    check('product_snapshots_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'product_snapshots_availability_check',
      sql`${t.availability} IN ('in_stock', 'out_of_stock', 'unknown')`,
    ),
    check('product_snapshots_promo_condition_check', sql`char_length(${t.promoCondition}) <= 120`),
    check('product_snapshots_description_check', sql`char_length(${t.description}) <= 1000`),
    check('product_snapshots_price_unit_check', sql`char_length(${t.priceUnit}) <= 20`),
    check('product_snapshots_units_check', sql`${t.unitsPerPackage} > 0 AND ${t.piecesPerPackage} > 0`),
    check('product_snapshots_extra_check', sql`jsonb_typeof(${t.extra}) = 'object'`),
    check('product_snapshots_final_url_check', sql`char_length(${t.finalUrl}) <= 2048`),
  ],
);

export const catalogSchema = { catalogProducts, catalogImports, catalogImportRows, productSnapshots };

export type CatalogProductRow = typeof catalogProducts.$inferSelect;
export type ProductSnapshotRow = typeof productSnapshots.$inferSelect;
export type NewProductSnapshot = typeof productSnapshots.$inferInsert;
export type CatalogImportRow = typeof catalogImports.$inferSelect;
