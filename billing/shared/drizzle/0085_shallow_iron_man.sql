CREATE TABLE "bridge_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" text NOT NULL,
	"action" text NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"litellm_key_hash" text NOT NULL,
	"metadata" jsonb,
	"error" text,
	CONSTRAINT "bridge_audit_action_check" CHECK ("bridge_audit_log"."action" IN ('provision', 'update', 'block', 'unblock', 'sync_failure'))
);
--> statement-breakpoint
CREATE TABLE "bridge_rate_limits" (
	"scope" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "bridge_rate_limits_pkey" PRIMARY KEY("scope","window_start")
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_usd" double precision,
	"credits_delta" double precision,
	"event_name" text,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "litellm_virtual_key" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "paypal_subscription_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "paypal_plan_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "paypal_payment_status" text;--> statement-breakpoint
CREATE INDEX "idx_bridge_audit_customer_ts" ON "bridge_audit_log" USING btree ("customer_id","ts");--> statement-breakpoint
CREATE INDEX "idx_bridge_audit_action_ts" ON "bridge_audit_log" USING btree ("action","ts");--> statement-breakpoint
CREATE INDEX "idx_wallet_ledger_customer_created_at" ON "wallet_ledger" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_customers_litellm_vkey" ON "customers" USING btree ("litellm_virtual_key") WHERE "customers"."litellm_virtual_key" IS NOT NULL;