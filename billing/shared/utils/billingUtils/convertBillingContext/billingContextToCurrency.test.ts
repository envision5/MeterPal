import { describe, expect, test } from "bun:test";
import type { Organization } from "../../../models/orgModels/orgTable.js";
import { billingContextToCurrency } from "./billingContextToCurrency.js";

const org = { default_currency: "usd" } as unknown as Organization;

describe("billingContextToCurrency", () => {
	test("explicit context currency wins (attach sets it with requested precedence)", () => {
		expect(
			billingContextToCurrency({
				org,
				billingContext: {
					currency: "EUR",
					fullCustomer: { currency: "gbp" },
				} as never,
			}),
		).toBe("eur");
	});

	test("falls back to the locked customer currency (non-attach actions)", () => {
		expect(
			billingContextToCurrency({
				org,
				billingContext: { fullCustomer: { currency: "GBP" } } as never,
			}),
		).toBe("gbp");
	});

	test("falls back to the org default when the customer is unlocked", () => {
		expect(
			billingContextToCurrency({
				org,
				billingContext: { fullCustomer: { currency: null } } as never,
			}),
		).toBe("usd");
	});
});
