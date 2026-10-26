CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"prompt_version" text NOT NULL,
	"config_version" integer,
	"provider" text,
	"model" text,
	"billing_mode" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 8),
	"cost_source" text,
	"latency_ms" integer,
	"score" smallint,
	"score_breakdown" jsonb,
	"triggers_model" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggers_code" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" text NOT NULL,
	"handoff_reason" text,
	"output" jsonb,
	"tool_calls" jsonb,
	"outbound_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_runs_decision_check" CHECK ("ai_runs"."decision" ~ '^(replied|asked_fields|asked_text|handed_off|none|skipped:[a-z_]+|blocked:[a-z_]+|error:[a-z_]+)$'),
	CONSTRAINT "ai_runs_handoff_reason_check" CHECK ("ai_runs"."handoff_reason" ~ '^[a-z0-9_:]{1,80}$'),
	CONSTRAINT "ai_runs_billing_mode_check" CHECK ("ai_runs"."billing_mode" IN ('platform', 'byok')),
	CONSTRAINT "ai_runs_cost_source_check" CHECK ("ai_runs"."cost_source" IN ('provider', 'estimated')),
	CONSTRAINT "ai_runs_provider_check" CHECK ("ai_runs"."provider" IN ('openrouter', 'anthropic', 'openai')),
	CONSTRAINT "ai_runs_score_check" CHECK ("ai_runs"."score" BETWEEN 0 AND 100),
	CONSTRAINT "ai_runs_counters_check" CHECK ("ai_runs"."input_tokens" >= 0 AND "ai_runs"."output_tokens" >= 0 AND "ai_runs"."latency_ms" >= 0 AND "ai_runs"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_configs_tenant_version_unique" UNIQUE("tenant_id","version"),
	CONSTRAINT "tenant_configs_version_check" CHECK ("tenant_configs"."version" > 0),
	CONSTRAINT "tenant_configs_config_object_check" CHECK (jsonb_typeof("tenant_configs"."config") = 'object')
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "lead_score" smallint;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "lead_score_peak" smallint;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "lead_score_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "score_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "lead_tier" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "qualification_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "hot_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "suggestions_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "extracted_data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "discovered_notes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handed_off_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handoff_reason" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handoff_summary" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_configs" ADD CONSTRAINT "tenant_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_runs_tenant_conversation_idx" ON "ai_runs" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_score_check" CHECK ("conversations"."lead_score" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_score_peak_check" CHECK ("conversations"."lead_score_peak" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_tier_check" CHECK ("conversations"."lead_tier" IN ('hot', 'warm', 'cold'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_turns_check" CHECK ("conversations"."qualification_turns" >= 0 AND "conversations"."hot_turns" >= 0 AND "conversations"."suggestions_count" >= 0);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_extracted_data_check" CHECK (jsonb_typeof("conversations"."extracted_data") = 'object');--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_discovered_notes_check" CHECK (jsonb_typeof("conversations"."discovered_notes") = 'array');--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_handoff_reason_check" CHECK ("conversations"."handoff_reason" ~ '^[a-z0-9_:]{1,80}$');--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_handoff_summary_check" CHECK (char_length("conversations"."handoff_summary") <= 2000);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_handoff_check" CHECK (("conversations"."handed_off_at" IS NULL) = ("conversations"."handoff_reason" IS NULL));