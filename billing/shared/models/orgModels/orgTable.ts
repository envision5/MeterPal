import type { PendingMigration } from "@models/migrationV2Models/pendingMigrationModel.js";
import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import type { CustomButton } from "./customButton.js";
import type { IdempotencyConfig } from "./idempotencyConfig.js";
import type { OrgConfig } from "./orgConfig.js";

export type SvixConfig = {
	sandbox_app_id: string;
	live_app_id: string;
};

export interface VersionConfig {
	sandbox?: string;
	live?: string;
	// sandbox_webhooks: string;
	// live_webhooks: string;
}

/**
 * One PayPal environment's connection for an org.
 *
 * `client_secret_enc` holds the secret encrypted with the repo's
 * `encryptData()` (ENCRYPTION_PASSWORD / ENCRYPTION_IV).  It is never
 * returned by an API.
 */
export type PaypalEnvConfig = {
	client_id: string;
	/** AES-256-CBC encrypted client secret via encryptData() */
	client_secret_enc: string;
	/** Webhook id this org registered with PayPal for this environment. */
	webhook_id?: string | null;
	/** The PayPal account this client acts on behalf of. */
	account_email?: string | null;
	/** Epoch ms when the org connected. */
	connected_at?: number;
};

/**
 * Per-org PayPal connection, split by PayPal environment.
 *
 * A PayPal REST app is per-environment: the sandbox app and the live app have
 * different client ids and secrets, so an org keeps one connection per
 * environment.
 *
 * An org with no `paypal_config` falls back to the PAYPAL_* environment
 * variables, so the single-tenant deployment keeps working unchanged.  Once an
 * org manages its own PayPal, the shared account never bills for it again:
 * a partially configured org is NOT connected in the environment it is missing.
 */
export type PaypalConfig = {
	test?: PaypalEnvConfig | null;
	live?: PaypalEnvConfig | null;
};

export type OrgRedisConfig = {
	/** AES-256-CBC encrypted full Redis connection string via encryptData() */
	connectionString: string;
	/**
	 * AES-256-CBC encrypted public/reachable-from-outside-the-VPC connection
	 * string, used off-AWS (local dev, trigger.dev) in place of `connectionString`.
	 */
	publicConnectionString?: string;
	/** Plain domain/host only, used for pool URL-change detection */
	url: string;
	/** Percentage of customers routed to the dedicated Redis (0-100) */
	migrationPercent: number;
	/** The migrationPercent before the last change, used for staleness detection */
	previousMigrationPercent: number;
	/** Epoch ms when migrationPercent was last changed */
	migrationChangedAt: number;
};

export const OrgClaimState = {
	Pending: "pending",
	Claimed: "claimed",
	Expiring: "expiring",
} as const;

export type OrgClaimState = (typeof OrgClaimState)[keyof typeof OrgClaimState];

export const OrgProvisioningSource = {
	Agent: "agent",
} as const;

export type OrgProvisioningSource =
	(typeof OrgProvisioningSource)[keyof typeof OrgProvisioningSource];

export const organizations = pgTable(
	"organizations",
	{
		id: text().primaryKey(),
		slug: text().notNull().unique(),

		// Better Auth
		name: text("name").notNull(),
		logo: text("logo"),
		createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
		metadata: text("metadata"),

		// Billing currency for this org's customers
		default_currency: text("default_currency").default("usd"),

		// PayPal
		paypal_connected: boolean("paypal_connected").default(false),
		paypal_config: jsonb("paypal_config").$type<PaypalConfig>(),

		test_pkey: text("test_pkey"),
		live_pkey: text("live_pkey"),

		svix_config: jsonb("svix_config")
			.$type<SvixConfig>()
			.default(sql`'{}'::jsonb`),

		created_at: numeric({ mode: "number" }),
		config: jsonb().default({}).notNull().$type<OrgConfig>(),
		idempotency_config: jsonb(
			"idempotency_config",
		).$type<IdempotencyConfig | null>(),
		custom_buttons: jsonb("custom_buttons")
			.default(sql`'[]'::jsonb`)
			.notNull()
			.$type<CustomButton[]>(),
		created_by: text("created_by"),
		onboarded: boolean("onboarded").default(false),
		deployed: boolean("deployed").default(false),
		is_sandbox: boolean("is_sandbox").default(false).notNull(),
		sandbox_color: text("sandbox_color"),
		sandbox_icon: text("sandbox_icon"),

		redis_config: jsonb("redis_config").$type<OrgRedisConfig>(),
		provisioning_source: text(
			"provisioning_source",
		).$type<OrgProvisioningSource>(),
		claim_state: text("claim_state").$type<OrgClaimState>(),
		claim_token_hash: text("claim_token_hash"),
		claim_expires_at: timestamp("claim_expires_at", { withTimezone: true }),
	},
	(table) => [
		index("idx_organizations_name_trgm")
			.using("gin", sql`${table.name} gin_trgm_ops`)
			.where(sql`${table.name} IS NOT NULL`),
		index("idx_organizations_slug_trgm")
			.using("gin", sql`${table.slug} gin_trgm_ops`)
			.where(sql`${table.slug} IS NOT NULL`),
		index("idx_organizations_created_at_id").on(
			sql`${table.createdAt} DESC`,
			sql`${table.id} DESC`,
		),
		index("idx_organizations_pending_claim_expiry")
			.on(table.claim_expires_at)
			.where(sql`${table.claim_state} = 'pending'`),
		unique("organizations_claim_token_hash_key").on(table.claim_token_hash),
		unique("organizations_test_pkey_key").on(table.test_pkey),
		unique("organizations_live_pkey_key").on(table.live_pkey),
	],
);

export type Organization = typeof organizations.$inferSelect & {
	master: Organization | null;
	pendingMigrations?: PendingMigration[];
	/** alias_id → live plan id. Empty (or omitted) for orgs with no renames. */
	planAliases?: Record<string, string>;
};

