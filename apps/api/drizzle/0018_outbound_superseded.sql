-- Tarea 024: una respuesta de la IA en cola se rechaza ('superseded') cuando una persona responde desde el
-- panel. Solo cambia el CHECK (igual que la 0014 de la tarea 010: al mergear queda una sola).
ALTER TABLE "outbound_messages" DROP CONSTRAINT "outbound_messages_reject_reason_check";--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_reject_reason_check" CHECK ("outbound_messages"."reject_reason" IN ('no_inbound', 'window_expired', 'contact_blocked', 'channel_unavailable', 'channel_paused', 'superseded'));