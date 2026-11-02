import {
	boolean,
	foreignKey,
	index,
	numeric,
	pgTable,
	text,
	unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../orgModels/orgTable";

/**
 * One model an org serves, and what the merchant charges for it.
 *
 * `model_id` is the billable id the bridge prices by — the exact
 * `<provider>/<model>` string, or `custom/<name>` for a merchant's own model.
 * `upstream_model` is the LiteLLM deployment name the gateway actually calls
 * ("demo-gpt"), which is usually the bare alias.
 *
 * Costs are USD per 1M tokens.  They are the merchant's PRICE, not the
 * provider's cost: the provider's live price (models.dev) is only the seed
 * used when the row is created.  Once a row exists, a models.dev change
 * cannot silently move the merchant's prices.
 */
export const servedModels = pgTable(
	"served_models",
	{
		internal_id: text("internal_id").primaryKey().notNull(),
		org_id: text("org_id").notNull(),
		env: text("env").notNull(),

		/** The billable id, e.g. "openai/gpt-4o" or "custom/demo-gpt". */
		model_id: text("model_id").notNull(),
		/** What the merchant calls it in the dashboard. */
		display_name: text("display_name"),
		/** The LiteLLM deployment name the gateway calls. */
		upstream_model: text("upstream_model"),
		enabled: boolean("enabled").notNull().default(true),

		input_cost_usd_1m: numeric("input_cost_usd_1m", { mode: "number" }),
		output_cost_usd_1m: numeric("output_cost_usd_1m", { mode: "number" }),
		/** The merchant's markup on this model, in percent. NULL = inherit the
		 *  plan's markup, so listing a model never silently drops the plan's
		 *  margin. */
		markup_pct: numeric("markup_pct", { mode: "number" }),

		created_at: numeric("created_at", { mode: "number" }),
		updated_at: numeric("updated_at", { mode: "number" }),
	},
	(table) => [
		foreignKey({
			columns: [table.org_id],
			foreignColumns: [organizations.id],
			name: "served_models_org_id_fkey",
		}).onDelete("cascade"),
		unique("served_models_org_env_model").on(
			table.org_id,
			table.env,
			table.model_id,
		),
		index("idx_served_models_composite").on(table.org_id, table.env).concurrently(),
	],
);

export type ServedModel = typeof servedModels.$inferSelect;
export type NewServedModel = typeof servedModels.$inferInsert;
