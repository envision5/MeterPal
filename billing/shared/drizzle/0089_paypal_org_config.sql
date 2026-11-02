ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "paypal_connected" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "paypal_config" jsonb;--> statement-breakpoint
