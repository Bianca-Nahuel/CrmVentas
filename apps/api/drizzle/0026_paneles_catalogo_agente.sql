CREATE TABLE "ai_playground_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"base_config_version" integer,
	"prompt_version" text NOT NULL,
	"provider" text,
	"model" text,
	"billing_mode" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 8),
	"cost_source" text,
	"latency_ms" integer,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_playground_runs_decision_check" CHECK ("ai_playground_runs"."decision" ~ '^(replied|asked_fields|asked_text|handed_off|none|blocked:[a-z_]+|error:[a-z_]+)$'),
	CONSTRAINT "ai_playground_runs_billing_mode_check" CHECK ("ai_playground_runs"."billing_mode" IN ('platform', 'byok')),
	CONSTRAINT "ai_playground_runs_cost_source_check" CHECK ("ai_playground_runs"."cost_source" IN ('provider', 'estimated')),
	CONSTRAINT "ai_playground_runs_provider_check" CHECK ("ai_playground_runs"."provider" IN ('openrouter', 'anthropic', 'openai')),
	CONSTRAINT "ai_playground_runs_counters_check" CHECK ("ai_playground_runs"."input_tokens" >= 0 AND "ai_playground_runs"."output_tokens" >= 0 AND "ai_playground_runs"."latency_ms" >= 0 AND "ai_playground_runs"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "catalog_import_files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"data" "bytea" NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_import_files_import_unique" UNIQUE("import_id"),
	CONSTRAINT "catalog_import_files_size_check" CHECK (octet_length("catalog_import_files"."data") BETWEEN 1 AND 5242880)
);
--> statement-breakpoint
ALTER TABLE "ai_playground_runs" ADD CONSTRAINT "ai_playground_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_files" ADD CONSTRAINT "catalog_import_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_playground_runs_tenant_created_idx" ON "ai_playground_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "catalog_import_files_expires_idx" ON "catalog_import_files" USING btree ("expires_at");