// billing/server/src/internal/salesAgent/offerPricing.ts
//
// The only place a negotiated price is ever computed.
//
// The sales agent cannot emit a number.  It emits a package id and an
// optional coupon id; this function maps those two enum values to a price
// using only merchant-declared data.  Every rejection below is a case where
// the requested offer is not something the merchant authorized — so the
// failure mode is "no offer", never "a cheap offer".
//
// Pure and dependency-free so it can be unit-tested without a database.

import type {
	SellerAgentMandate,
	SellerCoupon,
	SellerPackage,
} from "./sellerMandate.js";

/** What the model is allowed to ask for: two enum-ish references, no numbers. */
export type OfferRequest = {
	package_id: string;
	coupon_id?: string | null;
};

export type OfferRejectionCode =
	| "mandate_disabled"
	| "unknown_package"
	| "coupon_not_authorized"
	| "coupon_not_applicable"
	| "discount_exceeds_mandate"
	| "below_floor";

export type ResolvedOffer = {
	ok: true;
	package_id: string;
	name: string;
	credits: number;
	/** The merchant's published price for this package, before the coupon. */
	list_price_usd: number;
	/** What the customer actually pays. Always <= list_price_usd. */
	price_usd: number;
	discount_pct: number;
	unit_price_usd: number;
	coupon_id: string | null;
};

export type OfferRejection = {
	ok: false;
	code: OfferRejectionCode;
	reason: string;
	/** What the agent *can* offer, so it can recover in the next turn. */
	allowed_package_ids: string[];
	allowed_coupon_ids: string[];
};

export type OfferResolution = ResolvedOffer | OfferRejection;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const reject = (
	mandate: SellerAgentMandate,
	code: OfferRejectionCode,
	reason: string,
): OfferRejection => ({
	ok: false,
	code,
	reason,
	allowed_package_ids: mandate.packages.map((p) => p.package_id),
	allowed_coupon_ids: mandate.coupons.map((c) => c.coupon_id),
});

const findCoupon = (
	mandate: SellerAgentMandate,
	couponId: string,
): SellerCoupon | undefined =>
	mandate.coupons.find((c) => c.coupon_id === couponId);

const couponAppliesTo = (coupon: SellerCoupon, pkg: SellerPackage): boolean =>
	coupon.applies_to === null || coupon.applies_to.includes(pkg.package_id);

/**
 * Resolve a model-requested offer into a real price, or explain why the
 * merchant's mandate does not allow it.
 *
 * Invariants enforced here, in order:
 *   1. the mandate is on;
 *   2. the package exists on the ladder;
 *   3. the coupon (if any) is one the merchant authorized;
 *   4. the coupon applies to that package;
 *   5. the coupon's own discount is within `max_discount_pct`;
 *   6. the resulting unit price is at or above `min_unit_price_usd`.
 *
 * (5) and (6) are independent on purpose: (5) bounds the *rate* the agent may
 * give away, (6) bounds the *absolute* floor it may reach.  A generous coupon
 * on the cheapest rung trips (6) even though it passes (5).
 */
export const resolveOffer = ({
	mandate,
	offer,
}: {
	mandate: SellerAgentMandate;
	offer: OfferRequest;
}): OfferResolution => {
	if (!mandate.enabled) {
		return reject(mandate, "mandate_disabled", "The sales agent is disabled.");
	}

	const pkg = mandate.packages.find((p) => p.package_id === offer.package_id);
	if (!pkg) {
		return reject(
			mandate,
			"unknown_package",
			`'${offer.package_id}' is not a package on this merchant's ladder.`,
		);
	}

	let coupon: SellerCoupon | undefined;
	if (offer.coupon_id) {
		coupon = findCoupon(mandate, offer.coupon_id);
		if (!coupon) {
			return reject(
				mandate,
				"coupon_not_authorized",
				`'${offer.coupon_id}' is not a coupon this merchant authorized.`,
			);
		}
		if (!couponAppliesTo(coupon, pkg)) {
			return reject(
				mandate,
				"coupon_not_applicable",
				`'${coupon.coupon_id}' does not apply to '${pkg.package_id}'.`,
			);
		}
		if (coupon.discount_pct > mandate.max_discount_pct) {
			return reject(
				mandate,
				"discount_exceeds_mandate",
				`'${coupon.coupon_id}' is a ${coupon.discount_pct}% discount, above the ${mandate.max_discount_pct}% ceiling.`,
			);
		}
	}

	const discountPct = coupon?.discount_pct ?? 0;
	const price = round2(pkg.list_price_usd * (1 - discountPct / 100));
	const unit = round2(price / pkg.credits);

	if (unit < mandate.min_unit_price_usd) {
		return reject(
			mandate,
			"below_floor",
			`That would price a credit at $${unit.toFixed(2)}, below the $${mandate.min_unit_price_usd.toFixed(2)} floor.`,
		);
	}

	return {
		ok: true,
		package_id: pkg.package_id,
		name: pkg.name,
		credits: pkg.credits,
		list_price_usd: pkg.list_price_usd,
		price_usd: price,
		discount_pct: discountPct,
		unit_price_usd: unit,
		coupon_id: coupon?.coupon_id ?? null,
	};
};

/**
 * Render the mandate as the block the system prompt carries.  The agent reads
 * this to pick a rung; it is the only pricing information it ever sees.
 */
export const renderMandateContext = (mandate: SellerAgentMandate): string =>
	JSON.stringify(
		{
			packages: mandate.packages.map((p) => ({
				package_id: p.package_id,
				// The merchant authors this name in settings; it is what the
				// customer sees on the offer card and what the plan is called
				// once approved, so the agent should quote it too.
				name: p.name,
				credits: p.credits,
				price_usd: p.list_price_usd,
				unit_price_usd: round2(p.list_price_usd / p.credits),
			})),
			authorized_coupons: mandate.coupons.map((c) => ({
				coupon_id: c.coupon_id,
				discount_pct: c.discount_pct,
				applies_to: c.applies_to ?? "all packages",
			})),
			max_discount_pct: mandate.max_discount_pct,
			min_unit_price_usd: mandate.min_unit_price_usd,
		},
		null,
		1,
	);
