-- Tarea 007 (revisión de seguridad): la URL de un producto solo con ASCII imprimible, sin espacios. Se escribe
-- tal cual en el mensaje al cliente ({{link:SKU}}); un NBSP o un U+200B dejaba pegar texto después del link.
ALTER TABLE "catalog_products" DROP CONSTRAINT "catalog_products_url_check";--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_url_check" CHECK ("catalog_products"."url" ~ '^https://[!-~]+$' AND char_length("catalog_products"."url") <= 2048);