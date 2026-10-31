CREATE TABLE "paypal_order_intents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"org_id" text NOT NULL,
	"env" text NOT NULL,
	"customer_id" text NOT NULL,
	"product_id" text NOT NULL,
	"amount_usd" double precision NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_order_intents_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE INDEX "idx_paypal_order_intents_customer" ON "paypal_order_intents" USING btree ("customer_id","status");