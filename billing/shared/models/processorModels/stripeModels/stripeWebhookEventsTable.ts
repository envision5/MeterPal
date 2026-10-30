import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Webhook event ids already processed. The Stripe integration dedupes via
// Redis idempotency hooks; this table is the durable dedupe used by the
// PayPal integration, which prefixes ids with "paypal:" and reuses it.
export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
	event_id: text("event_id").primaryKey(),
	payload: jsonb("payload").$type<Record<string, unknown> | null>(),
	created_at: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export type DbStripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
export type InsertDbStripeWebhookEvent = typeof stripeWebhookEvents.$inferInsert;
