CREATE TABLE "conversation_metrics" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"first_inbound_at" timestamp with time zone,
	"first_human_reply_at" timestamp with time zone,
	"handed_off_at" timestamp with time zone,
	"first_human_reply_after_handoff_at" timestamp with time zone,
	"first_response_seconds_business" integer,
	"handoff_response_seconds_business" integer,
	"human_messages_count" integer DEFAULT 0 NOT NULL,
	"ai_messages_count" integer DEFAULT 0 NOT NULL,
	"inbound_count" integer DEFAULT 0 NOT NULL,
	"human_participated" boolean DEFAULT false NOT NULL,
	"unanswered" boolean DEFAULT false NOT NULL,
	"lead_tier_peak" text,
	"closed_at" timestamp with time zone,
	"close_outcome" text,
	"attributed_user_id" uuid,
	"attribution" text DEFAULT 'none' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_metrics_counters_check" CHECK ("conversation_metrics"."human_messages_count" >= 0 AND "conversation_metrics"."ai_messages_count" >= 0 AND "conversation_metrics"."inbound_count" >= 0
        AND "conversation_metrics"."first_response_seconds_business" >= 0 AND "conversation_metrics"."handoff_response_seconds_business" >= 0),
	CONSTRAINT "conversation_metrics_tier_check" CHECK ("conversation_metrics"."lead_tier_peak" IN ('hot', 'warm', 'cold')),
	CONSTRAINT "conversation_metrics_close_outcome_check" CHECK ("conversation_metrics"."close_outcome" IN ('sold', 'not_sold', 'no_response', 'not_a_lead', 'other', 'auto_inactive')),
	CONSTRAINT "conversation_metrics_attribution_check" CHECK ("conversation_metrics"."attribution" IN ('panel', 'single_seller', 'none')
        AND ("conversation_metrics"."attribution" = 'none') = ("conversation_metrics"."attributed_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "conversation_review_disputes" (
	"review_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"disputed_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_review_disputes_note_check" CHECK (char_length("conversation_review_disputes"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "conversation_reviews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"last_message_id" uuid NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"prompt_version" text NOT NULL,
	"config_version" integer NOT NULL,
	"model" text NOT NULL,
	"cost_usd" numeric(12, 8),
	"customer_outcome" text NOT NULL,
	"resolved" text NOT NULL,
	"output" jsonb NOT NULL,
	"discarded" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributed_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_reviews_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversation_reviews_customer_outcome_check" CHECK ("conversation_reviews"."customer_outcome" IN ('satisfied', 'neutral', 'dissatisfied', 'unknown')),
	CONSTRAINT "conversation_reviews_resolved_check" CHECK ("conversation_reviews"."resolved" IN ('yes', 'no', 'unknown')),
	CONSTRAINT "conversation_reviews_output_check" CHECK (jsonb_typeof("conversation_reviews"."output") = 'object'),
	CONSTRAINT "conversation_reviews_discarded_check" CHECK (jsonb_typeof("conversation_reviews"."discarded") = 'array'),
	CONSTRAINT "conversation_reviews_cost_check" CHECK ("conversation_reviews"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "review_digests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" numeric(12, 8),
	"reviews_count" integer NOT NULL,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_digests_channel_week_unique" UNIQUE("tenant_id","channel_id","week_start"),
	CONSTRAINT "review_digests_output_check" CHECK (jsonb_typeof("review_digests"."output") = 'object'),
	CONSTRAINT "review_digests_counters_check" CHECK ("review_digests"."reviews_count" >= 0 AND "review_digests"."cost_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_events" DROP CONSTRAINT "conversation_events_type_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "close_outcome" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "close_note" text;--> statement-breakpoint
-- Conversaciones cerradas antes de la tarea 026 (sin fecha ni resultado): las completa para el CHECK de
-- coherencia de abajo. Fecha = última actividad; resultado = 'other' (no se sabe).
UPDATE "conversations" SET "closed_at" = "last_message_at", "close_outcome" = 'other' WHERE "status" = 'closed';--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD CONSTRAINT "conversation_metrics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD CONSTRAINT "conversation_metrics_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id","channel_id") REFERENCES "public"."conversations"("tenant_id","id","channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_review_disputes" ADD CONSTRAINT "conversation_review_disputes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_review_disputes" ADD CONSTRAINT "conversation_review_disputes_review_fk" FOREIGN KEY ("tenant_id","review_id") REFERENCES "public"."conversation_reviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id","channel_id") REFERENCES "public"."conversations"("tenant_id","id","channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_last_message_fk" FOREIGN KEY ("tenant_id","last_message_id","conversation_id") REFERENCES "public"."messages"("tenant_id","id","conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_digests" ADD CONSTRAINT "review_digests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_digests" ADD CONSTRAINT "review_digests_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_metrics_opened_idx" ON "conversation_metrics" USING btree ("tenant_id","channel_id","opened_at");--> statement-breakpoint
CREATE INDEX "conversation_metrics_handoff_idx" ON "conversation_metrics" USING btree ("tenant_id","channel_id","handed_off_at") WHERE "conversation_metrics"."handed_off_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_metrics_closed_idx" ON "conversation_metrics" USING btree ("tenant_id","channel_id","closed_at") WHERE "conversation_metrics"."closed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_reviews_channel_idx" ON "conversation_reviews" USING btree ("tenant_id","channel_id","last_message_at");--> statement-breakpoint
CREATE INDEX "conversation_reviews_conversation_idx" ON "conversation_reviews" USING btree ("conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversation_reviews_created_idx" ON "conversation_reviews" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_open_last_message_idx" ON "conversations" USING btree ("tenant_id","last_message_at") WHERE "conversations"."status" = 'open';--> statement-breakpoint
CREATE INDEX "messages_human_channel_sent_at_idx" ON "messages" USING btree ("tenant_id","channel_id","sent_at") WHERE "messages"."sender_type" = 'user';--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_type_check" CHECK ("conversation_events"."type" IN ('ai_reactivated', 'closed'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_close_outcome_check" CHECK ("conversations"."close_outcome" IN ('sold', 'not_sold', 'no_response', 'not_a_lead', 'other', 'auto_inactive'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_close_note_check" CHECK (char_length("conversations"."close_note") <= 500);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_close_check" CHECK (("conversations"."status" = 'closed') = ("conversations"."closed_at" IS NOT NULL)
        AND ("conversations"."closed_at" IS NULL) = ("conversations"."close_outcome" IS NULL)
        AND ("conversations"."closed_at" IS NOT NULL OR ("conversations"."closed_by" IS NULL AND "conversations"."close_note" IS NULL))
        AND ("conversations"."close_outcome" IS DISTINCT FROM 'auto_inactive' OR "conversations"."closed_by" IS NULL));