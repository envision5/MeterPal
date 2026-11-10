import { z } from "zod/v4";

// MeterPal's own agent configuration, stored in `organizations.metadata`
// under `seller_agent_mandate` and `buyer_agent_defaults`.
//
// This is deliberately separate from `agentRules.ts` above, which is the
// generic MCP/chat agent's "what should you assume about my pricing" notes.
// These two objects are the machine-readable contract the MeterPal agents
// actually execute against:
//
//   seller_agent_mandate   what the merchant's sales agent may offer — the
//                          pricing ladder it may quote and the only coupons
//                          it may activate.  The agent can select from this;
//                          it can never author a price.
//   buyer_agent_defaults   the standing terms a customer's buying agent is
//                          offered when nobody has set a per-customer
//                          mandate — budget, per-purchase cap, auto-approve
//                          line.

/** One rung of the merchant's volume ladder. */
export const SellerPackageSchema = z.object({
	package_id: z
		.string()
		.min(1)
		.max(64)
		.regex(
			/^[a-z0-9_]+$/,
			"Use lowercase letters, numbers and underscores only",
		),
	name: z.string().min(1).max(120),
	credits: z.number().positive(),
	list_price_usd: z.number().positive(),
});

/** A discount the merchant pre-authorizes the agent to activate. */
export const SellerCouponSchema = z.object({
	coupon_id: z
		.string()
		.min(1)
		.max(64)
		.regex(
			/^[a-z0-9_]+$/,
			"Use lowercase letters, numbers and underscores only",
		),
	discount_pct: z.number().min(0).max(100),
	/** Package ids it may apply to; null = every package. */
	applies_to: z.array(z.string()).nullable().default(null),
	max_redemptions: z.number().int().positive().nullable().default(null),
});

export const SellerAgentMandateSchema = z.object({
	enabled: z.boolean().default(true),
	/** Ceiling on any single coupon the agent may activate. */
	max_discount_pct: z.number().min(0).max(100).default(15),
	/** Absolute floor: no offer may price a credit below this. */
	min_unit_price_usd: z.number().min(0).default(0.75),
	packages: z.array(SellerPackageSchema).min(1, "Add at least one package"),
	coupons: z.array(SellerCouponSchema).default([]),
});

export const BuyerAgentDefaultsSchema = z
	.object({
		enabled: z.boolean().default(true),
		/** Largest single purchase (USD) the buyer's agent may initiate. */
		max_per_purchase: z.number().positive().default(50),
		/** Calendar-month spend ceiling (USD) before it stands down. */
		monthly_budget: z.number().positive().default(100),
		/** Purchases at or below this skip the in-app confirmation. */
		auto_approve_below: z.number().nonnegative().default(15),
	})
	.refine((v) => v.auto_approve_below <= v.max_per_purchase, {
		message: "Auto-approve line cannot exceed the per-purchase cap",
		path: ["auto_approve_below"],
	})
	.refine((v) => v.max_per_purchase <= v.monthly_budget, {
		message: "Per-purchase cap cannot exceed the monthly budget",
		path: ["max_per_purchase"],
	});

export type SellerPackage = z.infer<typeof SellerPackageSchema>;
export type SellerCoupon = z.infer<typeof SellerCouponSchema>;
export type SellerAgentMandate = z.infer<typeof SellerAgentMandateSchema>;
export type BuyerAgentDefaults = z.infer<typeof BuyerAgentDefaultsSchema>;

export const DEFAULT_SELLER_AGENT_MANDATE: SellerAgentMandate = {
	enabled: true,
	max_discount_pct: 15,
	min_unit_price_usd: 0.75,
	packages: [
		{ package_id: "pack_10", name: "Starter top-up", credits: 10, list_price_usd: 10 },
		{ package_id: "pack_50", name: "Team top-up", credits: 50, list_price_usd: 50 },
		{ package_id: "pack_100", name: "Growth top-up", credits: 100, list_price_usd: 95 },
		{ package_id: "pack_200", name: "Scale top-up", credits: 200, list_price_usd: 180 },
		{ package_id: "pack_500", name: "Volume top-up", credits: 500, list_price_usd: 425 },
	],
	coupons: [
		{
			coupon_id: "launch_10",
			discount_pct: 10,
			applies_to: null,
			max_redemptions: null,
		},
		{
			coupon_id: "volume_5",
			discount_pct: 5,
			applies_to: ["pack_200", "pack_500"],
			max_redemptions: null,
		},
	],
};

export const DEFAULT_BUYER_AGENT_DEFAULTS: BuyerAgentDefaults = {
	enabled: true,
	max_per_purchase: 50,
	monthly_budget: 100,
	auto_approve_below: 15,
};

/** What the settings page reads and writes, and what the agents execute. */
export type AgentConfig = {
	seller_agent_mandate: SellerAgentMandate;
	buyer_agent_defaults: BuyerAgentDefaults;
};

const METADATA_KEY_SELLER = "seller_agent_mandate";
const METADATA_KEY_BUYER = "buyer_agent_defaults";

/**
 * Read both configs out of the org's metadata blob.
 *
 * `organizations.metadata` is a TEXT column holding JSON.  A parse failure or
 * a malformed object falls back to the default rather than widening the
 * agent's authority — a broken config must never make the agent more
 * permissive than the shipped defaults.
 */
export const readAgentConfig = (
	metadata: string | null | undefined,
): AgentConfig => {
	let parsed: Record<string, unknown> | null = null;
	if (metadata) {
		try {
			const json = JSON.parse(metadata);
			if (json && typeof json === "object") {
				parsed = json as Record<string, unknown>;
			}
		} catch {
			parsed = null;
		}
	}

	const seller = SellerAgentMandateSchema.safeParse(parsed?.[METADATA_KEY_SELLER]);
	const buyer = BuyerAgentDefaultsSchema.safeParse(parsed?.[METADATA_KEY_BUYER]);

	return {
		seller_agent_mandate: seller.success
			? seller.data
			: DEFAULT_SELLER_AGENT_MANDATE,
		buyer_agent_defaults: buyer.success
			? buyer.data
			: DEFAULT_BUYER_AGENT_DEFAULTS,
	};
};

/**
 * Merge a validated config back into the raw metadata blob, preserving any
 * unrelated keys another feature stored there.
 */
export const writeAgentConfig = (
	metadata: string | null | undefined,
	config: Partial<AgentConfig>,
): string => {
	let base: Record<string, unknown> = {};
	if (metadata) {
		try {
			const json = JSON.parse(metadata);
			if (json && typeof json === "object") {
				base = json as Record<string, unknown>;
			}
		} catch {
			base = {};
		}
	}

	if (config.seller_agent_mandate !== undefined) {
		base[METADATA_KEY_SELLER] = config.seller_agent_mandate;
	}
	if (config.buyer_agent_defaults !== undefined) {
		base[METADATA_KEY_BUYER] = config.buyer_agent_defaults;
	}

	return JSON.stringify(base);
};
