-- Tarea 010: la segunda parte de una respuesta de la IA se rechaza ('superseded') si antes de enviarla
-- escribió el cliente, respondió una persona o la primera parte no salió. Solo cambia el CHECK: sin
-- tablas, permisos ni políticas nuevas.
ALTER TABLE "outbound_messages" DROP CONSTRAINT "outbound_messages_reject_reason_check";--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_reject_reason_check" CHECK ("outbound_messages"."reject_reason" IN ('no_inbound', 'window_expired', 'contact_blocked', 'channel_unavailable', 'channel_paused', 'superseded'));