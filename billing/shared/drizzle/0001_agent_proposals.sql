CREATE TABLE "agent_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" text NOT NULL,
	"internal_customer_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"conversation" jsonb,
	"plan_id" text,
	"created_at" numeric NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_agent_proposals_org_env_status" ON "agent_proposals" USING btree ("org_id","env","status");
--> statement-breakpoint
CREATE INDEX "idx_agent_proposals_customer" ON "agent_proposals" USING btree ("internal_customer_id","created_at");
