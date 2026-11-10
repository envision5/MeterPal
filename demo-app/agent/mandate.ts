// demo-app/agent/mandate.ts
//
// The buyer agent's decision policy — pure and unit-tested.  Given the
// customer's mandate, the real paywall numbers, and observed usage, decide
// what the agent does when a call is refused with 402:
//
//   initiate — within the mandate and at or under the auto-approve line: the
//              agent starts the PayPal checkout immediately.  PayPal's own
//              approval stays the human gate on the money itself.
//   ask      — the purchase is allowed but above the auto-approve line: the
//              agent drafts a topup_authorization proposal and waits.
//   deny     — the mandate says no (budget spent, caps exclude every pack).
//
// Pack sizing is usage-aware: buying just enough for the refused call means
// another 402 on the very next message.  The agent sizes the purchase to the
// shortfall + any overdrawn balance + a few days of steady burn, then picks
// the cheapest pack that covers that target.  "Steady burn" is the
// trailing-7-day daily average, NOT the last 24 hours: one huge call should
// not size the purchase, or a single expensive afternoon would buy the
// customer a year of credits.  Hard mandate caps (max_per_purchase,
// monthly_budget) are never exceeded — when they bind, the agent buys the
// best affordable pack and says so in its reason.

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

/** Live signals from the ledger + the 402, used to size the purchase. */
export type UsageSignals = {
	/** Spendable wallet balance in credits; may be negative when overdrawn. */
	balance?: number;
	/**
	 * The steady daily burn the agent plans against: the trailing-7-day
	 * daily average, excluding the last 24 hours.  Sizing on this instead of
	 * the last 24h keeps one outsized call from dictating the purchase.
	 */
	baselineDaily?: number;
	/** Credits consumed in the trailing 24h — reported for context only. */
	burnRatePerDay?: number;
};

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

/** Days of steady burn the agent buys ahead for, to avoid a 402 per message. */
export const AGENT_RUNWAY_DAYS = 3;

export const decideTopUp = ({
	mandate,
	monthSpend,
	packs,
	requiredCredits,
	usage,
}: {
	mandate: BuyerMandate;
	/** Credits spent this calendar month, from the ledger. */
	monthSpend: number;
	/** The merchant's one-off packs (the buyer agent may only buy these). */
	packs: Pack[];
	/** Credits the refused call needed (from the 402). */
	requiredCredits: number;
	/** Optional live usage signals; when absent the shortfall alone sizes the buy. */
	usage?: UsageSignals;
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

	// A 402 only tells us the shortfall for THIS call.  Size the pack for the
	// actual situation: clear any overdraft and buy a few days of runway at
	// the customer's STEADY burn rate, so the agent does not top up $10 every
	// message.  The steady rate is the trailing-7-day daily average — the
	// last 24 hours is reported for context but never sizes the purchase,
	// because one outsized call must not buy a year of credits.
	const debt = Math.max(0, -(usage?.balance ?? 0));
	const baseline = Math.max(0, usage?.baselineDaily ?? 0);
	const recent = Math.max(0, usage?.burnRatePerDay ?? 0);
	const targetCredits =
		requiredCredits + debt + baseline * AGENT_RUNWAY_DAYS;

	// Affordable = within the per-purchase cap AND the remaining budget.
	// Sufficient = enough credits to clear the admission floor that refused us.
	const affordable = packs
		.filter(
			(pack) =>
				pack.price_usd <= mandate.max_per_purchase &&
				pack.price_usd <= budgetLeft,
		)
		.sort((a, b) => a.price_usd - b.price_usd);

	const cheapest = [...packs].sort((a, b) => a.price_usd - b.price_usd)[0];
	if (affordable.length === 0) {
		if (cheapest && budgetLeft < cheapest.price_usd) {
			return {
				action: "deny",
				pack: null,
				reason: `Every pack that covers ${requiredCredits.toFixed(2)} credits exceeds the per-purchase cap ($${mandate.max_per_purchase.toFixed(2)}) or the remaining budget ($${budgetLeft.toFixed(2)}) — agent standing down.`,
			};
		}
		return {
			action: "deny",
			pack: null,
			reason: `Every pack exceeds the per-purchase cap ($${mandate.max_per_purchase.toFixed(2)}). Raise the caps to let the agent buy more.`,
		};
	}

	const candidates = affordable.filter(
		(pack) => pack.credits >= requiredCredits,
	);
	if (candidates.length === 0) {
		return {
			action: "deny",
			pack: null,
			reason: `No pack in the mandate covers the ${requiredCredits.toFixed(2)} credits this call needs (largest affordable: ${affordable[affordable.length - 1].credits}). Raise the caps to let the agent buy more.`,
		};
	}

	// Prefer the cheapest pack that covers the usage-sized target; if the
	// mandate caps bind, take the largest affordable pack that still gets the
	// customer back online instead of standing down entirely.
	const coveringTarget = candidates.filter(
		(pack) => pack.credits >= targetCredits,
	);
	const pack = coveringTarget[0] ?? candidates[candidates.length - 1];

	const observation =
		debt > 0 || baseline > 0
			? ` Planning ${AGENT_RUNWAY_DAYS} days of steady burn (${baseline.toFixed(2)} credits/day${
					recent > baseline ? `, ${recent.toFixed(2)} in the last 24h` : ""
				})${debt > 0 ? ` plus a ${debt.toFixed(2)}-credit overdraft` : ""} — sized for ${targetCredits.toFixed(2)} credits.`
			: "";
	const largerPacks = packs.filter((p) => p.credits > pack.credits);
	const capsBind = largerPacks.some(
		(p) =>
			p.price_usd > mandate.max_per_purchase || p.price_usd > budgetLeft,
	);
	const capped =
		pack.credits < targetCredits
			? capsBind
				? ` Best affordable pack under your $${mandate.max_per_purchase.toFixed(2)} per-purchase cap — raise it to let the agent match your usage.`
				: ` Largest pack this merchant sells; the ${targetCredits.toFixed(2)}-credit target exceeds the catalog.`
			: "";

	if (pack.price_usd > mandate.auto_approve_below) {
		return {
			action: "ask",
			pack,
			reason: `${pack.credits} credits for $${pack.price_usd.toFixed(2)} clears the ${requiredCredits.toFixed(2)}-credit shortfall but is above your auto-approve line ($${mandate.auto_approve_below.toFixed(2)}) — approve to continue.${observation}${capped}`,
		};
	}

	return {
		action: "initiate",
		pack,
		reason: `Auto-approved within your mandate: ${pack.credits} credits for $${pack.price_usd.toFixed(2)} (≤ $${mandate.auto_approve_below.toFixed(2)} auto-approve line, $${budgetLeft.toFixed(2)} budget left).${observation}${capped} PayPal still asks you to approve the payment.`,
	};
};
