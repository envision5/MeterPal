import {
	foreignKey,
	index,
	jsonb,
	numeric,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { organizations } from "../orgModels/orgTable";
import { servedModels } from "./servedModelTable";

/**
 * One instance of a served model, wired to a real provider deployment.
 *
 * A merchant adds N of these (each with its own API key) to spread a model's
 * traffic across provider accounts: every deployment in the table is pushed
 * to the LiteLLM gateway under one per-org, per-env model name, and the
 * gateway's router load-balances across the group.
 *
 * `api_key_enc` is the provider key, AES-encrypted at rest (same scheme as
 * PayPal's client_secret_enc). It is re-pushed to the gateway on update, so
 * it has to be recoverable — but it never leaves the server: responses carry
 * only `api_key_hint`, the last four characters.
 */
export const servedModelDeployments = pgTable(
	"served_model_deployments",
	{
		internal_id: text("internal_id").primaryKey().notNull(),
		org_id: text("org_id").notNull(),
		env: text("env").notNull(),

		/** The billable id of the served model this instance belongs to. */
		model_id: text("model_id").notNull(),
		/** The provider-prefixed model, e.g. "openai/gpt-4o-mini". */
		provider_model: text("provider_model").notNull(),
		/** An OpenAI-compatible base URL, when the provider is not first-party. */
		api_base: text("api_base"),
		/** The provider API key, encrypted. Never returned by the API. */
		api_key_enc: text("api_key_enc").notNull(),
		/** Last four characters, for the dashboard's "which key is this" read. */
		api_key_hint: text("api_key_hint").notNull(),
		/** The LiteLLM model row this deployment created, for deletes/updates. */
		gateway_model_id: text("gateway_model_id"),

		/** Optional per-instance rate ceiling; the gateway weights routing by it. */
		rpm: numeric("rpm", { mode: "number" }),
		tpm: numeric("tpm", { mode: "number" }),

		/** Optional LiteLLM deployment params, surfaced as first-class fields. */
		timeout: numeric("timeout", { mode: "number" }),
		max_retries: numeric("max_retries", { mode: "number" }),
		weight: numeric("weight", { mode: "number" }),
		/** LiteLLM's `order` param — lower orders are tried first. */
		routing_order: numeric("routing_order", { mode: "number" }),
		organization: text("organization"),

		/**
		 * Anything else LiteLLM accepts on a deployment, as a JSON object —
		 * encrypted whole, because provider credential families (Azure,
		 * Vertex, Bedrock) routinely hold secrets. `extra_params_keys` keeps
		 * the non-sensitive key names so the dashboard can show what is set.
		 */
		extra_params_enc: text("extra_params_enc"),
		extra_params_keys: jsonb("extra_params_keys").$type<string[]>(),

		created_at: numeric("created_at", { mode: "number" }),
		updated_at: numeric("updated_at", { mode: "number" }),
	},
	(table) => [
		foreignKey({
			columns: [table.org_id],
			foreignColumns: [organizations.id],
			name: "served_model_deployments_org_id_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [
				table.org_id,
				table.env,
				table.model_id,
			],
			foreignColumns: [
				servedModels.org_id,
				servedModels.env,
				servedModels.model_id,
			],
			name: "served_model_deployments_model_fkey",
		}).onDelete("cascade"),
		index("idx_served_model_deployments_composite").on(
			table.org_id,
			table.env,
			table.model_id,
		),
	],
);

export type ServedModelDeployment = typeof servedModelDeployments.$inferSelect;
export type NewServedModelDeployment = typeof servedModelDeployments.$inferInsert;
