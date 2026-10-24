CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone_number" text NOT NULL,
	"provider" text NOT NULL,
	"connection_type" text NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"default_user_id" uuid,
	"risk_accepted_at" timestamp with time zone,
	"risk_accepted_by" uuid,
	"provider_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "channels_tenant_phone_unique" UNIQUE("tenant_id","phone_number"),
	CONSTRAINT "channels_provider_external_id_unique" UNIQUE("provider","external_id"),
	CONSTRAINT "channels_phone_e164_check" CHECK ("channels"."phone_number" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "channels_provider_check" CHECK ("channels"."provider" IN ('waha', 'cloud_api')),
	CONSTRAINT "channels_connection_type_check" CHECK ("channels"."connection_type" IN ('official', 'unofficial')),
	CONSTRAINT "channels_status_check" CHECK ("channels"."status" IN ('pending', 'connected', 'disconnected', 'banned')),
	CONSTRAINT "channels_provider_connection_check" CHECK (("channels"."provider" = 'waha' AND "channels"."connection_type" = 'unofficial') OR ("channels"."provider" = 'cloud_api' AND "channels"."connection_type" = 'official')),
	CONSTRAINT "channels_risk_accepted_check" CHECK ("channels"."connection_type" <> 'unofficial' OR ("channels"."risk_accepted_at" IS NOT NULL AND "channels"."risk_accepted_by" IS NOT NULL)),
	CONSTRAINT "channels_provider_config_object_check" CHECK (jsonb_typeof("channels"."provider_config") = 'object')
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wa_id" text NOT NULL,
	"profile_name" text,
	"display_name" text,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"opt_in_at" timestamp with time zone,
	"blocked" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "contacts_tenant_wa_id_unique" UNIQUE("tenant_id","wa_id"),
	CONSTRAINT "contacts_opt_in_check" CHECK (NOT "contacts"."marketing_opt_in" OR "contacts"."opt_in_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"inbox" text DEFAULT 'sales' NOT NULL,
	"assigned_user_id" uuid,
	"ai_paused_until" timestamp with time zone,
	"last_message_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_tenant_id_channel_unique" UNIQUE("tenant_id","id","channel_id"),
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" IN ('open', 'closed', 'archived')),
	CONSTRAINT "conversations_inbox_check" CHECK ("conversations"."inbox" IN ('sales', 'other'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"direction" text NOT NULL,
	"sender_type" text NOT NULL,
	"sent_by_user_id" uuid,
	"type" text NOT NULL,
	"body" text,
	"media_key" text,
	"status" text,
	"cost_usd" numeric(10, 5),
	"raw" jsonb NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_channel_external_id_unique" UNIQUE("channel_id","external_id"),
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "messages_sender_type_check" CHECK ("messages"."sender_type" IN ('contact', 'ai', 'user', 'app')),
	CONSTRAINT "messages_type_check" CHECK ("messages"."type" IN ('text', 'image', 'audio', 'video', 'document', 'location', 'other')),
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" IN ('received', 'sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "messages_direction_sender_check" CHECK (("messages"."direction" = 'inbound') = ("messages"."sender_type" = 'contact'))
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_risk_accepted_by_users_id_fk" FOREIGN KEY ("risk_accepted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id","channel_id") REFERENCES "public"."conversations"("tenant_id","id","channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_open_unique" ON "conversations" USING btree ("channel_id","contact_id") WHERE "conversations"."status" = 'open';--> statement-breakpoint
CREATE INDEX "conversations_tenant_last_message_idx" ON "conversations" USING btree ("tenant_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_tenant_assigned_idx" ON "conversations" USING btree ("tenant_id","assigned_user_id");--> statement-breakpoint
CREATE INDEX "conversations_tenant_channel_idx" ON "conversations" USING btree ("tenant_id","channel_id");--> statement-breakpoint
CREATE INDEX "conversations_tenant_contact_idx" ON "conversations" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_sent_at_idx" ON "messages" USING btree ("conversation_id","sent_at");