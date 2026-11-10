// billing/server/tests/paypal_grant_balance.test.ts
//
// Regression tests for "payment was made, but the credits were not added":
// a paid credit pack landing on an overdrawn wallet used to be applied with
// add_to_balance, which merely shrank a debt the customer API hides — the
// buyer kept seeing 0.00 credits and kept hitting the 402 paywall.
//
// Run with: bun test ./tests/paypal_grant_balance.test.ts

import { describe, expect, it } from "bun:test";
import { grantBalanceParams } from "../src/external/paypal/grantBalanceParams.js";

const base = {
	customerId: "demo-customer",
	featureId: "ai_tokens",
	amountUsd: 10,
};

describe("grantBalanceParams — paid credit pack on an overdrawn wallet", () => {
	it("lands the balance AT the pack size when the wallet is underwater", () => {
		expect(
			grantBalanceParams({ ...base, currentBalance: -250, settleOverdraft: true }),
		).toEqual({
			customer_id: "demo-customer",
			feature_id: "ai_tokens",
			remaining: 10,
		});
	});

	it("still settles even a tiny overdraft", () => {
		expect(
			grantBalanceParams({ ...base, currentBalance: -0.01, settleOverdraft: true }),
		).toMatchObject({ remaining: 10 });
	});

	it("adds normally on a healthy wallet", () => {
		expect(
			grantBalanceParams({ ...base, currentBalance: 0, settleOverdraft: true }),
		).toEqual({
			customer_id: "demo-customer",
			feature_id: "ai_tokens",
			add_to_balance: 10,
		});
		expect(
			grantBalanceParams({ ...base, currentBalance: 42, settleOverdraft: true }),
		).toMatchObject({ add_to_balance: 10 });
	});

	it("never settles when the balance is unknown", () => {
		expect(
			grantBalanceParams({ ...base, currentBalance: null, settleOverdraft: true }),
		).toMatchObject({ add_to_balance: 10 });
	});
});

describe("grantBalanceParams — non-pack grants keep additive semantics", () => {
	it("does not settle overlarge debt on a subscription cycle", () => {
		expect(
			grantBalanceParams({
				...base,
				amountUsd: 100,
				currentBalance: -250,
				settleOverdraft: false,
			}),
		).toMatchObject({ add_to_balance: 100 });
	});

	it("applies a refund as a plain negative grant", () => {
		expect(
			grantBalanceParams({
				...base,
				amountUsd: -10,
				currentBalance: -250,
				settleOverdraft: true,
			}),
		).toMatchObject({ add_to_balance: -10 });
	});
});
