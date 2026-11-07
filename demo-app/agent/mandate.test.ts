// demo-app/agent/mandate.test.ts — decision matrix for the buyer agent.
// Run: bun test agent/mandate.test.ts

import { describe, expect, test } from "bun:test";
import { decideTopUp, type BuyerMandate, type Pack } from "./mandate";

const PACKS: Pack[] = [
	{ product_id: "topup_10", credits: 10, price_usd: 10 },
	{ product_id: "topup_50", credits: 50, price_usd: 50 },
	{ product_id: "topup_200", credits: 200, price_usd: 200 },
];

const MANDATE: BuyerMandate = {
	enabled: true,
	max_per_purchase: 50,
	monthly_budget: 100,
	auto_approve_below: 15,
};

const decide = (overrides: Partial<Parameters<typeof decideTopUp>[0]> = {}) =>
	decideTopUp({
		mandate: MANDATE,
		monthSpend: 0,
		packs: PACKS,
		requiredCredits: 0.5,
		...overrides,
	});

describe("decideTopUp", () => {
	test("disabled mandate denies", () => {
		const decision = decide({
			mandate: { ...MANDATE, enabled: false },
		});
		expect(decision.action).toBe("deny");
		expect(decision.reason).toContain("disabled");
	});

	test("spent budget denies", () => {
		const decision = decide({ monthSpend: 100 });
		expect(decision.action).toBe("deny");
		expect(decision.reason).toContain("budget");
	});

	test("small shortfall under the auto-approve line initiates the cheapest sufficient pack", () => {
		const decision = decide({ requiredCredits: 0.5 });
		expect(decision.action).toBe("initiate");
		expect(decision.pack?.product_id).toBe("topup_10");
		expect(decision.reason).toContain("PayPal");
	});

	test("asks when the only sufficient pack is above the auto-approve line", () => {
		const decision = decide({
			mandate: { ...MANDATE, auto_approve_below: 5 },
			requiredCredits: 0.5,
		});
		expect(decision.action).toBe("ask");
		expect(decision.pack?.product_id).toBe("topup_10");
	});

	test("picks the smallest pack that clears a large shortfall", () => {
		const decision = decide({
			mandate: {
				...MANDATE,
				max_per_purchase: 250,
				auto_approve_below: 250,
				monthly_budget: 500,
			},
			requiredCredits: 60,
		});
		expect(decision.action).toBe("initiate");
		expect(decision.pack?.product_id).toBe("topup_200");
	});

	test("cap-exclusion with no covering pack denies and says to raise the caps", () => {
		const decision = decide({
			mandate: { ...MANDATE, max_per_purchase: 20 },
			requiredCredits: 60,
		});
		expect(decision.action).toBe("deny");
		expect(decision.reason).toContain("Raise the caps");
	});

	test("remaining budget narrows what the agent may buy", () => {
		const decision = decide({ monthSpend: 95, requiredCredits: 0.5 });
		// $5 left: topup_10 is $10 — over budget → deny.
		expect(decision.action).toBe("deny");
		expect(decision.reason).toContain("budget");
	});

	test("no pack big enough for the shortfall denies with a raise-the-caps hint", () => {
		const decision = decide({
			mandate: { ...MANDATE, max_per_purchase: 5 },
			requiredCredits: 60,
		});
		expect(decision.action).toBe("deny");
		expect(decision.reason).toContain("Raise the caps");
	});
});
