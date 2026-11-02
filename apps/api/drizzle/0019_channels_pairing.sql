CREATE TABLE "channel_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"type" text NOT NULL,
	"user_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_events_type_check" CHECK ("channel_events"."type" IN ('created', 'connected', 'disconnected', 'reconnect_requested', 'sending_resumed', 'phone_mismatch', 'number_in_use')),
	CONSTRAINT "channel_events_data_check" CHECK (jsonb_typeof("channel_events"."data") = 'object')
);
--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_tenant_phone_unique";--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "phone_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "disconnect_reason" text;--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_events_channel_idx" ON "channel_events" USING btree ("channel_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_phone_unique" UNIQUE("phone_number");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_connected_phone_check" CHECK ("channels"."status" <> 'connected' OR "channels"."phone_number" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_disconnect_reason_check" CHECK ("channels"."disconnect_reason" IN ('logged_out', 'phone_mismatch', 'number_in_use', 'pairing_expired', 'session_failed'));