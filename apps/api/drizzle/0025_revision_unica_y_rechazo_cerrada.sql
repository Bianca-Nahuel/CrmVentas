-- Tarea 026 (revisores): no se puede responder en una conversación cerrada (motivo conversation_closed en las
-- reglas de envío) y una sola revisión por estado de la conversación (el trabajo diario y dev:review a la vez).
ALTER TABLE "outbound_messages" DROP CONSTRAINT "outbound_messages_reject_reason_check";--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_reviews_last_message_unique" ON "conversation_reviews" USING btree ("conversation_id","last_message_id");--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_reject_reason_check" CHECK ("outbound_messages"."reject_reason" IN ('no_inbound', 'window_expired', 'contact_blocked', 'channel_unavailable', 'channel_paused', 'conversation_closed', 'superseded'));