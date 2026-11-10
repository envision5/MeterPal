// billing/server/src/internal/salesAgent/offerPricing.test.ts
//
// The guarantee under test: the sales agent can select a rung and a coupon,
// and NOTHING else.  Every case where the model asks for something the
// merchant did not declare must come back as a rejection, never a cheap
// offer.
//
// Run: bun test src/internal/salesAgent/offerPricing.test.ts

import { describe, expect, test } from "bun:test";
import { DEFAULT_SELLER_AGENT_MANDATE } from "@autumn/shared";
import { renderMandateContext, resolveOffer } from "./offerPricing.js";
import { readSellerMandate, type SellerAgentMandate } from "./sellerMandate.js";

const MANDATE = DEFAULT_SELLER_AGENT_MANDATE;

const resolve = (
	offer: { package_id: string; coupon_id?: string | null },
	mandate: SellerAgentMandate = MANDATE,
) => resolveOffer({ mandate, offer });

describe("resolveOffer — the merchant's ladder is the only price", () => {
	test("a package with no coupon prices at list", () => {
		const result = resolve({ package_id: "pack_100" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.credits).toBe(100);
		expect(result.list_price_usd).toBe(95);
		expect(result.price_usd).toBe(95);
		expect(result.discount_pct).toBe(0);
		expect(result.unit_price_usd).toBe(0.95);
	});

	test("an authorized coupon reduces the list price", () => {
		const result = resolve({ package_id: "pack_100", coupon_id: "launch_10" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.price_usd).toBe(85.5);
		expect(result.discount_pct).toBe(10);
		expect(result.unit_price_usd).toBe(0.86); // 85.5/100 rounded to cents
	});

	test("volume discount is baked into the ladder, not the coupon", () => {
		const small = resolve({ package_id: "pack_10" });
		const large = resolve({ package_id: "pack_500" });
		expect(small.ok && large.ok).toBe(true);
		if (!small.ok || !large.ok) return;
		expect(small.unit_price_usd).toBe(1);
		expect(large.unit_price_usd).toBe(0.85);
		expect(large.unit_price_usd).toBeLessThan(small.unit_price_usd);
	});
});

describe("resolveOffer — the model cannot reach outside the mandate", () => {
	test("a package not on the ladder is refused", () => {
		const result = resolve({ package_id: "pack_1000000" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("unknown_package");
		expect(result.allowed_package_ids).toEqual([
			"pack_10",
			"pack_50",
			"pack_100",
			"pack_200",
			"pack_500",
		]);
	});

	test("a coupon the merchant never authorized is refused", () => {
		const result = resolve({ package_id: "pack_100", coupon_id: "friends_90" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("coupon_not_authorized");
	});

	test("an authorized coupon still cannot apply to the wrong package", () => {
		// volume_5 is scoped to pack_200/pack_500.
		const result = resolve({ package_id: "pack_50", coupon_id: "volume_5" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("coupon_not_applicable");
	});

	test("a coupon above the discount ceiling is refused", () => {
		const wide: SellerAgentMandate = {
			...MANDATE,
			coupons: [
				{ coupon_id: "fire_sale", discount_pct: 25, applies_to: null, max_redemptions: null },
			],
		};
		const result = resolve({ package_id: "pack_100", coupon_id: "fire_sale" }, wide);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("discount_exceeds_mandate");
		expect(result.reason).toContain("25%");
	});

	test("a discount that breaches the unit-price floor is refused", () => {
		// 15% off pack_500 = $361.25 / 500 = $0.7225, under the $0.75 floor.
		const deep: SellerAgentMandate = {
			...MANDATE,
			coupons: [
				{ coupon_id: "big_15", discount_pct: 15, applies_to: null, max_redemptions: null },
			],
		};
		const result = resolve({ package_id: "pack_500", coupon_id: "big_15" }, deep);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("below_floor");
	});

	test("a disabled mandate sells nothing", () => {
		const off: SellerAgentMandate = { ...MANDATE, enabled: false };
		const result = resolve({ package_id: "pack_100" }, off);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("mandate_disabled");
	});

	test("no combination can price a credit below the floor", () => {
		// Exhaustive sweep: every package x every authorized coupon.
		for (const pkg of MANDATE.packages) {
			for (const coupon of MANDATE.coupons) {
				const result = resolve({
					package_id: pkg.package_id,
					coupon_id: coupon.coupon_id,
				});
				if (!result.ok) continue;
				expect(result.unit_price_usd).toBeGreaterThanOrEqual(
					MANDATE.min_unit_price_usd,
				);
				expect(result.price_usd).toBeLessThanOrEqual(result.list_price_usd);
				expect(result.discount_pct).toBeLessThanOrEqual(
					MANDATE.max_discount_pct,
				);
			}
		}
	});
});

describe("readSellerMandate", () => {
	test("missing metadata falls back to the default", () => {
		expect(readSellerMandate(null)).toEqual(DEFAULT_SELLER_AGENT_MANDATE);
	});

	test("malformed JSON falls back rather than widening authority", () => {
		expect(readSellerMandate("{not json")).toEqual(DEFAULT_SELLER_AGENT_MANDATE);
	});

	test("a malformed mandate falls back rather than widening authority", () => {
		const bad = JSON.stringify({
			seller_agent_mandate: { enabled: true, max_discount_pct: 99 },
		});
		expect(readSellerMandate(bad)).toEqual(DEFAULT_SELLER_AGENT_MANDATE);
	});

	test("a well-formed mandate is honoured", () => {
		const custom = {
			seller_agent_mandate: {
				enabled: true,
				max_discount_pct: 20,
				min_unit_price_usd: 0.5,
				packages: [
					{ package_id: "custom_1", name: "Custom", credits: 1000, list_price_usd: 800 },
				],
				coupons: [],
			},
		};
		const mandate = readSellerMandate(JSON.stringify(custom));
		expect(mandate.packages[0].package_id).toBe("custom_1");
		expect(mandate.max_discount_pct).toBe(20);
	});
});

describe("renderMandateContext", () => {
	test("exposes ids and list prices but no derived prices", () => {
		const rendered = renderMandateContext(MANDATE);
		expect(rendered).toContain("pack_100");
		expect(rendered).toContain("launch_10");
		expect(rendered).toContain("max_discount_pct");
		// The rendered block is the ladder, not a computed offer.
		expect(rendered).not.toContain("price_usd\":8");
	});
});
