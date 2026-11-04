CREATE TABLE IF NOT EXISTS "served_model_deployments" (
	"internal_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" text NOT NULL,
	"model_id" text NOT NULL,
	"provider_model" text NOT NULL,
	"api_base" text,
	"api_key_enc" text NOT NULL,
	"api_key_hint" text NOT NULL,
	"gateway_model_id" text,
	"rpm" numeric,
	"tpm" numeric,
	"created_at" numeric,
	"updated_at" numeric
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "served_model_deployments" ADD CONSTRAINT "served_model_deployments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "served_model_deployments" ADD CONSTRAINT "served_model_deployments_model_fkey" FOREIGN KEY ("org_id","env","model_id") REFERENCES "served_models"("org_id","env","model_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_served_model_deployments_composite" ON "served_model_deployments" ("org_id","env","model_id");
