import { sql } from "drizzle-orm";
import {
	bigserial,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	doublePrecision,
} from "drizzle-orm/pg-core";

// ─── LiteLLM bridge ───────────────────────────────────────────────────────
// Tables backing the LiteLLM ↔ Autumn billing bridge. The customers table
// carries litellm_virtual_key / paypal_* columns (see cusTable.ts).

// Audit trail for bridge key operations (provision/update/block/unblock).
// Written by server/src/internal/keys/litellmKeys.ts.
export const bridgeAuditLog = pgTable(
	"bridge_audit_log",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
		customer_id: text("customer_id").notNull(),
		action: text("action").notNull(),
		actor: text("actor").notNull().default("system"),
		// SHA-256 of the virtual key — never the key itself.
		litellm_key_hash: text("litellm_key_hash").notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
		error: text("error"),
	},
	(table) => [
		check(
			"bridge_audit_action_check",
			sql`${table.action} IN ('provision', 'update', 'block', 'unblock', 'sync_failure')`,
		),
		index("idx_bridge_audit_customer_ts").on(table.customer_id, table.ts),
		index("idx_bridge_audit_action_ts").on(table.action, table.ts),
	],
);

// Fixed-window rate-limit counters for bridge public endpoints.
export const bridgeRateLimits = pgTable(
	"bridge_rate_limits",
	{
		// 'customer:<id>' | 'ip:<addr>'
		scope: text("scope").notNull(),
		window_start: timestamp("window_start", { withTimezone: true }).notNull(),
		counter: integer("counter").notNull().default(0),
	},
	(table) => [
		primaryKey({
			columns: [table.scope, table.window_start],
			name: "bridge_rate_limits_pkey",
		}),
	],
);

// Money-movement ledger for wallet top-ups and corrections (e.g. PayPal
// PAYMENT.CAPTURE.COMPLETED, refunds). idempotency_key is unique so webhook
// replays never double-credit a customer.
export const walletLedger = pgTable(
	"wallet_ledger",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		customer_id: text("customer_id").notNull(),
		// 'topup' | 'refund' | 'correction'
		kind: text("kind").notNull(),
		amount_usd: doublePrecision("amount_usd"),
		credits_delta: doublePrecision("credits_delta"),
		event_name: text("event_name"),
		idempotency_key: text("idempotency_key").notNull().unique(),
		metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
		created_at: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("idx_wallet_ledger_customer_created_at").on(
			table.customer_id,
			table.created_at,
		),
	],
);

export type DbBridgeAuditLog = typeof bridgeAuditLog.$inferSelect;
export type InsertDbBridgeAuditLog = typeof bridgeAuditLog.$inferInsert;
export type DbWalletLedger = typeof walletLedger.$inferSelect;
export type InsertDbWalletLedger = typeof walletLedger.$inferInsert;
