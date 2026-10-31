import {
	bigserial,
	doublePrecision,
	index,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

/**
 * One row per PayPal Orders v2 checkout created for a customer.  Written at
 * checkout creation; the finalize/poll endpoint reads it to capture APPROVED
 * orders without depending on PayPal's browser redirect (sandbox hermes
 * loops instead of redirecting to localhost return URLs).
 */
export const paypalOrderIntents = pgTable(
	"paypal_order_intents",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		order_id: text("order_id").notNull().unique(),
		org_id: text("org_id").notNull(),
		env: text("env").notNull(),
		customer_id: text("customer_id").notNull(),
		product_id: text("product_id").notNull(),
		amount_usd: doublePrecision("amount_usd").notNull(),
		status: text("status").notNull().default("pending"),
		created_at: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("idx_paypal_order_intents_customer").on(
			table.customer_id,
			table.status,
		),
	],
);

export type DbPaypalOrderIntent = typeof paypalOrderIntents.$inferSelect;
export type InsertDbPaypalOrderIntent = typeof paypalOrderIntents.$inferInsert;
