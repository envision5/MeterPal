import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Webhook event ids already processed — the durable dedupe used by the
// PayPal integration, which prefixes ids with "paypal:".
export const webhookEvents = pgTable("webhook_events", {
	event_id: text("event_id").primaryKey(),
	payload: jsonb("payload").$type<Record<string, unknown> | null>(),
	created_at: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export type DbWebhookEvent = typeof webhookEvents.$inferSelect;
export type InsertDbWebhookEvent = typeof webhookEvents.$inferInsert;
