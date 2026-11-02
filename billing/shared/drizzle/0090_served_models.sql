CREATE TABLE IF NOT EXISTS "served_models" (
	"internal_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" text NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text,
	"upstream_model" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"input_cost_usd_1m" numeric,
	"output_cost_usd_1m" numeric,
	"markup_pct" numeric,
	"created_at" numeric,
	"updated_at" numeric,
	CONSTRAINT "served_models_org_env_model" UNIQUE("org_id","env","model_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "served_models" ADD CONSTRAINT "served_models_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_served_models_composite" ON "served_models" ("org_id","env");