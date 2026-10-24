-- Generada con drizzle-kit (tarea 005). A mano: el UNIQUE de messages va antes de la FK de outbound_messages
-- que lo usa (drizzle-kit lo ponía al final y la FK fallaba).
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"sender_type" text NOT NULL,
	"sent_by_user_id" uuid,
	"body" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reject_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"external_id" text,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_messages_tenant_idempotency_unique" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "outbound_messages_sender_type_check" CHECK ("outbound_messages"."sender_type" IN ('ai', 'user', 'app')),
	CONSTRAINT "outbound_messages_status_check" CHECK ("outbound_messages"."status" IN ('queued', 'sending', 'sent', 'failed', 'rejected')),
	CONSTRAINT "outbound_messages_reject_reason_check" CHECK ("outbound_messages"."reject_reason" IN ('no_inbound', 'window_expired', 'contact_blocked', 'channel_unavailable', 'channel_paused')),
	CONSTRAINT "outbound_messages_rejected_reason_check" CHECK (("outbound_messages"."status" = 'rejected') = ("outbound_messages"."reject_reason" IS NOT NULL)),
	CONSTRAINT "outbound_messages_last_error_check" CHECK ("outbound_messages"."last_error" IN ('transient', 'rate_limited', 'session_down', 'blocked_risk', 'invalid_recipient', 'unknown_outcome')),
	CONSTRAINT "outbound_messages_sent_external_id_check" CHECK ("outbound_messages"."status" <> 'sent' OR "outbound_messages"."external_id" IS NOT NULL),
	CONSTRAINT "outbound_messages_body_length_check" CHECK (char_length("outbound_messages"."body") BETWEEN 1 AND 4096),
	CONSTRAINT "outbound_messages_idempotency_key_check" CHECK (char_length("outbound_messages"."idempotency_key") BETWEEN 1 AND 200),
	CONSTRAINT "outbound_messages_attempts_check" CHECK ("outbound_messages"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "sending_paused_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "sending_paused_reason" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_conversation_unique" UNIQUE("tenant_id","id","conversation_id");
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id","channel_id") REFERENCES "public"."conversations"("tenant_id","id","channel_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_message_fk" FOREIGN KEY ("tenant_id","message_id","conversation_id") REFERENCES "public"."messages"("tenant_id","id","conversation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_messages_channel_external_id_unique" ON "outbound_messages" USING btree ("channel_id","external_id") WHERE "outbound_messages"."external_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "outbound_messages_channel_claimed_idx" ON "outbound_messages" USING btree ("channel_id","claimed_at");
--> statement-breakpoint
CREATE INDEX "outbound_messages_conversation_claimed_idx" ON "outbound_messages" USING btree ("conversation_id","claimed_at");
--> statement-breakpoint
CREATE INDEX "outbound_messages_conversation_sending_idx" ON "outbound_messages" USING btree ("conversation_id") WHERE "outbound_messages"."status" = 'sending';
--> statement-breakpoint
