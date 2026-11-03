ALTER TABLE "conversations" ADD COLUMN "lead_tier_peak" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "close_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "handoff_seconds_business" integer;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "sold_seconds_business" integer;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "close_amount" numeric(14, 2);--> statement-breakpoint
CREATE INDEX "conversations_stalled_idx" ON "conversations" USING btree ("tenant_id","lead_score" DESC NULLS LAST) WHERE "conversations"."status" = 'open' AND "conversations"."lead_tier_peak" = 'hot';--> statement-breakpoint
CREATE INDEX "conversation_metrics_first_inbound_idx" ON "conversation_metrics" USING btree ("tenant_id","first_inbound_at") WHERE "conversation_metrics"."first_inbound_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_tier_peak_check" CHECK ("conversations"."lead_tier_peak" IN ('hot', 'warm', 'cold'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_close_amount_check" CHECK ("conversations"."close_amount" IS NULL OR ("conversations"."close_amount" > 0 AND "conversations"."close_outcome" = 'sold'));--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD CONSTRAINT "conversation_metrics_funnel_seconds_check" CHECK ("conversation_metrics"."handoff_seconds_business" >= 0 AND "conversation_metrics"."sold_seconds_business" >= 0);--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD CONSTRAINT "conversation_metrics_close_amount_check" CHECK ("conversation_metrics"."close_amount" > 0);