CREATE TABLE "paypal_catalog_map" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" text NOT NULL,
	"product_id" text NOT NULL,
	"paypal_product_id" text,
	"paypal_plan_id" text,
	"name" text,
	"interval" text,
	"amount_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "paypal_payer_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_paypal_catalog_map_unique" ON "paypal_catalog_map" USING btree ("org_id","env","product_id");--> statement-breakpoint
CREATE INDEX "idx_paypal_catalog_map_plan_id" ON "paypal_catalog_map" USING btree ("paypal_plan_id");--> statement-breakpoint
CREATE INDEX "idx_customers_paypal_payer_id" ON "customers" USING btree ("org_id","env","paypal_payer_id") WHERE "customers"."paypal_payer_id" IS NOT NULL;