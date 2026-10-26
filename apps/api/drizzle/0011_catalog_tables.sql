CREATE TABLE "catalog_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"sku" text,
	"data" jsonb NOT NULL,
	"status" text NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"change" text,
	"changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_jump" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_import_rows_import_row_unique" UNIQUE("import_id","row_number"),
	CONSTRAINT "catalog_import_rows_status_check" CHECK ("catalog_import_rows"."status" IN ('valid', 'invalid')),
	CONSTRAINT "catalog_import_rows_change_check" CHECK ("catalog_import_rows"."change" IN ('new', 'changed', 'unchanged')),
	CONSTRAINT "catalog_import_rows_row_number_check" CHECK ("catalog_import_rows"."row_number" > 0),
	CONSTRAINT "catalog_import_rows_data_check" CHECK (jsonb_typeof("catalog_import_rows"."data") = 'object'),
	CONSTRAINT "catalog_import_rows_errors_check" CHECK (jsonb_typeof("catalog_import_rows"."errors") = 'array')
);
--> statement-breakpoint
CREATE TABLE "catalog_imports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"file_size" integer NOT NULL,
	"sheet_name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"base_import_id" uuid,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_invalid" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"changed_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"missing_count" integer DEFAULT 0 NOT NULL,
	"price_jump_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	CONSTRAINT "catalog_imports_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "catalog_imports_status_check" CHECK ("catalog_imports"."status" IN ('preview', 'applied', 'reverted', 'failed')),
	CONSTRAINT "catalog_imports_sha256_check" CHECK ("catalog_imports"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_imports_file_name_check" CHECK (char_length("catalog_imports"."file_name") BETWEEN 1 AND 255),
	CONSTRAINT "catalog_imports_sheet_name_check" CHECK (char_length("catalog_imports"."sheet_name") BETWEEN 1 AND 100),
	CONSTRAINT "catalog_imports_file_size_check" CHECK ("catalog_imports"."file_size" > 0),
	CONSTRAINT "catalog_imports_mapping_check" CHECK (jsonb_typeof("catalog_imports"."mapping") = 'object'),
	CONSTRAINT "catalog_imports_counts_check" CHECK ("catalog_imports"."rows_total" >= 0 AND "catalog_imports"."rows_invalid" >= 0 AND "catalog_imports"."new_count" >= 0 AND "catalog_imports"."changed_count" >= 0
        AND "catalog_imports"."unchanged_count" >= 0 AND "catalog_imports"."missing_count" >= 0 AND "catalog_imports"."price_jump_count" >= 0),
	CONSTRAINT "catalog_imports_error_code_check" CHECK ("catalog_imports"."error_code" ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "catalog_products" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"unit" text DEFAULT 'unit' NOT NULL,
	"units_per_package" numeric(12, 4),
	"pieces_per_package" integer,
	"url" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_products_tenant_sku_unique" UNIQUE("tenant_id","sku"),
	CONSTRAINT "catalog_products_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "catalog_products_sku_check" CHECK ("catalog_products"."sku" ~ '^[A-Za-z0-9._/-]{1,64}$'),
	CONSTRAINT "catalog_products_name_check" CHECK (char_length("catalog_products"."name") BETWEEN 1 AND 300),
	CONSTRAINT "catalog_products_category_check" CHECK (char_length("catalog_products"."category") <= 120),
	CONSTRAINT "catalog_products_unit_check" CHECK ("catalog_products"."unit" IN ('m2', 'ml', 'unit', 'box', 'kg', 'l')),
	CONSTRAINT "catalog_products_units_per_package_check" CHECK ("catalog_products"."units_per_package" > 0),
	CONSTRAINT "catalog_products_pieces_per_package_check" CHECK ("catalog_products"."pieces_per_package" > 0),
	CONSTRAINT "catalog_products_url_check" CHECK ("catalog_products"."url" ~ '^https://[^[:space:]]+$' AND char_length("catalog_products"."url") <= 2048),
	CONSTRAINT "catalog_products_attributes_check" CHECK (jsonb_typeof("catalog_products"."attributes") = 'object')
);
--> statement-breakpoint
CREATE TABLE "product_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"source" text NOT NULL,
	"import_id" uuid,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"error_code" text,
	"list_price" numeric(14, 2),
	"promo_price" numeric(14, 2),
	"promo_condition" text,
	"price_no_taxes" numeric(14, 2),
	"currency" text DEFAULT 'ARS' NOT NULL,
	"price_unit" text,
	"units_per_package" numeric(12, 4),
	"pieces_per_package" integer,
	"availability" text DEFAULT 'unknown' NOT NULL,
	"description" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"field_sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"final_url" text,
	"http_status" smallint,
	CONSTRAINT "product_snapshots_source_check" CHECK ("product_snapshots"."source" IN ('web', 'excel')),
	CONSTRAINT "product_snapshots_error_code_check" CHECK ("product_snapshots"."error_code" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "product_snapshots_ok_check" CHECK ("product_snapshots"."ok" OR "product_snapshots"."error_code" IS NOT NULL),
	CONSTRAINT "product_snapshots_prices_check" CHECK ("product_snapshots"."list_price" > 0 AND "product_snapshots"."promo_price" > 0 AND "product_snapshots"."price_no_taxes" > 0),
	CONSTRAINT "product_snapshots_currency_check" CHECK ("product_snapshots"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "product_snapshots_availability_check" CHECK ("product_snapshots"."availability" IN ('in_stock', 'out_of_stock', 'unknown')),
	CONSTRAINT "product_snapshots_promo_condition_check" CHECK (char_length("product_snapshots"."promo_condition") <= 120),
	CONSTRAINT "product_snapshots_description_check" CHECK (char_length("product_snapshots"."description") <= 1000),
	CONSTRAINT "product_snapshots_price_unit_check" CHECK (char_length("product_snapshots"."price_unit") <= 20),
	CONSTRAINT "product_snapshots_units_check" CHECK ("product_snapshots"."units_per_package" > 0 AND "product_snapshots"."pieces_per_package" > 0),
	CONSTRAINT "product_snapshots_extra_check" CHECK (jsonb_typeof("product_snapshots"."extra") = 'object'),
	CONSTRAINT "product_snapshots_final_url_check" CHECK (char_length("product_snapshots"."final_url") <= 2048)
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "catalog_citations" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_import_rows" ADD CONSTRAINT "catalog_import_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_imports" ADD CONSTRAINT "catalog_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_snapshots" ADD CONSTRAINT "product_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_import_rows_tenant_import_idx" ON "catalog_import_rows" USING btree ("tenant_id","import_id");--> statement-breakpoint
CREATE INDEX "catalog_imports_tenant_created_idx" ON "catalog_imports" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "catalog_products_tenant_active_idx" ON "catalog_products" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE INDEX "product_snapshots_product_read_idx" ON "product_snapshots" USING btree ("tenant_id","product_id","read_at");