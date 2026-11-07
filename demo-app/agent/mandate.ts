// demo-app/agent/mandate.ts
//
// The buyer agent's decision policy — pure and unit-tested.  Given the
// customer's mandate and the real paywall numbers, decide what the agent does
// when a call is refused with 402:
//
//   initiate — within the mandate and at or under the auto-approve line: the
//              agent starts the PayPal checkout immediately.  PayPal's own
//              approval stays the human gate on the money itself.
//   ask      — the purchase is allowed but above the auto-approve line: the
//              agent drafts a topup_authorization proposal and waits.
//   deny     — the mandate says no (budget spent, caps exclude every pack).

export type BuyerMandate = {
	enabled: boolean;
	/** Largest single purchase (USD) the agent may initiate. */
	max_per_purchase: number;
	/** Calendar-month spend ceiling (USD) — the agent stops at the line. */
	monthly_budget: number;
	/** Purchases up to this price skip the in-app confirmation. */
	auto_approve_below: number;
};

export type Pack = { product_id: string; credits: number; price_usd: number };

export type AgentDecision = {
	action: "initiate" | "ask" | "deny";
	pack: Pack | null;
	reason: string;
};

export const DECISION_ENABLED_FIELDS: (keyof BuyerMandate)[] = [
	"enabled",
	"max_per_purchase",
	"monthly_budget",
	"auto_approve_below",
];

export const decideTopUp = ({
	mandate,
	monthSpend,
	packs,
	requiredCredits,
}: {
	mandate: BuyerMandate;
	/** Credits spent this calendar month, from the ledger. */
	monthSpend: number;
	/** The merchant's one-off packs (the buyer agent may only buy these). */
	packs: Pack[];
	/** Credits the refused call needed (from the 402). */
	requiredCredits: number;
}): AgentDecision => {
	if (!mandate.enabled) {
		return { action: "deny", pack: null, reason: "Buyer agent is disabled." };
	}

	const budgetLeft = mandate.monthly_budget - monthSpend;
	if (budgetLeft <= 0) {
		return {
			action: "deny",
			pack: null,
			reason: `Monthly budget of $${mandate.monthly_budget.toFixed(2)} is spent ($${monthSpend.toFixed(2)} used) — agent standing down.`,
		};
	}

	// Affordable = within the per-purchase cap AND the remaining budget.
	// Sufficient = enough credits to clear the admission floor that refused us.
	const candidates = packs
		.filter(
			(pack) =>
				pack.credits >= requiredCredits &&
				pack.price_usd <= mandate.max_per_purchase &&
				pack.price_usd <= budgetLeft,
		)
		.sort((a, b) => a.price_usd - b.price_usd);

	if (candidates.length === 0) {
		const cheapest = [...packs].sort((a, b) => a.price_usd - b.price_usd)[0];
		if (cheapest && cheapest.credits < requiredCredits) {
			return {
				action: "deny",
				pack: null,
				reason: `No pack in the mandate covers the ${requiredCredits.toFixed(2)} credits this call needs (largest affordable: ${cheapest.credits}). Raise the caps to let the agent buy more.`,
			};
		}
		return {
			action: "deny",
			pack: null,
			reason: `Every pack that covers ${requiredCredits.toFixed(2)} credits exceeds the per-purchase cap ($${mandate.max_per_purchase.toFixed(2)}) or the remaining budget ($${budgetLeft.toFixed(2)}).`,
		};
	}

	const pack = candidates[0];
	if (pack.price_usd > mandate.auto_approve_below) {
		return {
			action: "ask",
			pack,
			reason: `${pack.credits} credits for $${pack.price_usd.toFixed(2)} clears the ${requiredCredits.toFixed(2)}-credit shortfall but is above your auto-approve line ($${mandate.auto_approve_below.toFixed(2)}) — approve to continue.`,
		};
	}

	return {
		action: "initiate",
		pack,
		reason: `Auto-approved within your mandate: ${pack.credits} credits for $${pack.price_usd.toFixed(2)} (≤ $${mandate.auto_approve_below.toFixed(2)} auto-approve line, $${(mandate.monthly_budget - monthSpend).toFixed(2)} budget left). PayPal still asks you to approve the payment.`,
	};
};
