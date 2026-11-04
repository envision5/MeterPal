import {
	bigserial,
	check,
	foreignKey,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./orgTable";

/**
 * Who changed what merchant-facing configuration, and when.
 *
 * Spec §5: every config change (connect, disconnect, served model edit, price
 * change) writes an audit entry with the acting user.  This is the SOC2
 * change-management trail for the dashboard's control surfaces -- distinct
 * from `bridge_audit_log`, which records key lifecycle events per customer.
 *
 * `actor` is resolved by the auth layer: the dashboard session's user for
 * internal routes, the secret key's org for API routes, "system" for
 * server-initiated writes.
 */
export const configAuditLog = pgTable(
	"config_audit_log",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
		org_id: text("org_id").notNull(),
		env: text("env").notNull(),

		/** Who made the change: session user id, "secret_key", or "system". */
		actor: text("actor").notNull().default("system"),
		/** What changed, dot-namespaced: paypal.connect, served_model.upsert, ... */
		action: text("action").notNull(),
		/** The thing that changed: a product id, a model id, "org". */
		resource: text("resource").notNull(),

		metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
	},
	(table) => [
		foreignKey({
			columns: [table.org_id],
			foreignColumns: [organizations.id],
			name: "config_audit_log_org_id_fkey",
		}).onDelete("cascade"),
		check(
			"config_audit_log_env_check",
			sql`${table.env} IN ('sandbox', 'live', 'production')`,
		),
		index("idx_config_audit_org_ts").on(table.org_id, table.ts),
		index("idx_config_audit_action_ts").on(table.action, table.ts),
	],
);

export type ConfigAuditLog = typeof configAuditLog.$inferSelect;
export type NewConfigAuditLog = typeof configAuditLog.$inferInsert;
