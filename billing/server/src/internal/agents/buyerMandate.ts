// billing/server/src/internal/agents/buyerMandate.ts
//
// The buyer's standing instruction to an agent that manages their wallet.
//
// It lives in the customer's metadata on the billing server, so both sides
// of the agent loop read the same contract:
//   - the agent host (the demo app's buyer agent) decides what to buy,
//   - the billing core watches for the wallet running dry and needs to know
//     whether this customer gave an agent permission to act on it.
//
// Kept in its own module so the balance path can read the mandate without
// dragging the sales agent's inference plumbing into a hot deduction.

import { z } from "zod/v4";

export type BuyerAgentMandate = {
	enabled: boolean;
	/** Largest single purchase (USD) the buyer agent may initiate itself. */
	max_per_purchase: number;
	/** Calendar-month spend ceiling (USD) beyond which the agent stops. */
	monthly_budget: number;
	/** Purchases up to this price skip the in-app confirmation and go
	 *  straight to PayPal's approval (the human gate on money). */
	auto_approve_below: number;
};

const MANDATE_SCHEMA = z.object({
	enabled: z.boolean(),
	max_per_purchase: z.number().positive(),
	monthly_budget: z.number().positive(),
	auto_approve_below: z.number().nonnegative(),
});

/** The mandate on a customer, or null when nobody is managing their wallet. */
export const readMandate = (
	metadata: Record<string, any> | null | undefined,
): BuyerAgentMandate | null => {
	const raw = metadata?.buyer_agent_mandate;
	if (!raw || typeof raw !== "object" || raw.enabled !== true) return null;
	const parsed = MANDATE_SCHEMA.safeParse(raw);
	return parsed.success ? parsed.data : null;
};
