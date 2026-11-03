-- Embudo de ventas (tarea 028): permisos de las columnas nuevas de 0030. Las tablas ya tienen RLS por empresa
-- y por número (0003, 0015, 0022, 0023); acá solo se suma lo justo para escribir las columnas nuevas.

-- Nivel máximo alcanzado: lo escribe el worker de la IA (y el backfill), nunca baja (lo controla el UPDATE).
GRANT UPDATE (lead_tier_peak) ON conversations TO ventas_app;
--> statement-breakpoint
-- Monto aproximado de la venta: lo escribe el cierre, solo con close_outcome = 'sold' (CHECK de 0030).
GRANT UPDATE (close_amount) ON conversations TO ventas_app;
--> statement-breakpoint
-- Métricas: las recalcula refreshConversationMetrics (upsert), como el resto de sus columnas (0022).
GRANT UPDATE (handoff_seconds_business, sold_seconds_business, close_amount) ON conversation_metrics TO ventas_app;
