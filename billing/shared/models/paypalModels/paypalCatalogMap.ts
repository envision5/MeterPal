import {
	bigserial,
	doublePrecision,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Maps a MeterPal product (Autumn plan/product id) to its PayPal catalog
 * counterpart (catalog product + billing plan).  Written by the catalog sync
 * script and lazily by the PayPal checkout path (auto-provision on first
 * subscription checkout).  Lookup key: (org_id, env, product_id) unique;
 * webhook handlers resolve paypal_plan_id -> product_id via the plan index.
 */
export const paypalCatalogMap = pgTable(
	"paypal_catalog_map",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		org_id: text("org_id").notNull(),
		env: text("env").notNull(),
		product_id: text("product_id").notNull(),
		paypal_product_id: text("paypal_product_id"),
		paypal_plan_id: text("paypal_plan_id"),
		name: text("name"),
		interval: text("interval"),
		amount_usd: doublePrecision("amount_usd"),
		created_at: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("idx_paypal_catalog_map_unique").on(
			table.org_id,
			table.env,
			table.product_id,
		),
		index("idx_paypal_catalog_map_plan_id").on(table.paypal_plan_id),
	],
);

export type DbPaypalCatalogMap = typeof paypalCatalogMap.$inferSelect;
export type InsertDbPaypalCatalogMap = typeof paypalCatalogMap.$inferInsert;
