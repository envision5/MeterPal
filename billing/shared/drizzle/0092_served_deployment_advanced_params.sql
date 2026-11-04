ALTER TABLE "served_model_deployments" ADD COLUMN IF NOT EXISTS "timeout" numeric;
--> statement-breakpoint
ALTER TABLE "served_model_deployments" ADD COLUMN IF NOT EXISTS "max_retries" numeric;
--> statement-breakpoint
ALTER TABLE "served_model_deployments" ADD COLUMN IF NOT EXISTS "weight" numeric;
--> statement-breakpoint
ALTER TABLE "served_model_deployments" ADD COLUMN IF NOT EXISTS "routing_order" numeric;
--> statement-breakpoint
ALTER TABLE "served_model_deployments" ADD COLUMN IF NOT EXISTS "organization" text;
--> statement-breakpoint
ALTER TABLE "served_model_deployments" ADD COLUMN IF NOT EXISTS "extra_params_enc" text;
--> statement-breakpoint
ALTER TABLE "served_model_deployments" ADD COLUMN IF NOT EXISTS "extra_params_keys" jsonb;
