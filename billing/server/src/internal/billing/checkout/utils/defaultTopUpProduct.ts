// billing/server/src/internal/billing/checkout/utils/defaultTopUpProduct.ts
//
// The 402 paywall's `topUp()` opens a checkout without naming a product --
// the SDK caller knows their user is broke, not which credit pack to sell.
// Default to the merchant's cheapest one-off credit pack so the paywall
// always has a way out; if the merchant sells none, return null and the
// checkout fails with the normal product-not-found error.

import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { ProductService } from "@/internal/products/ProductService.js";
import { priceAmountUsd } from "@/internal/billing/paypal/runPaypalCheckout.js";

export const defaultTopUpProductId = async ({
	ctx,
}: {
	ctx: AutumnContext;
}): Promise<string | null> => {
	const { db, org, env } = ctx;

	const products = await ProductService.listFull({ db, orgId: org.id, env });

	let best: { id: string; amount: number } | null = null;
	for (const product of products) {
		for (const price of product.prices) {
			// One-off prices are the credit packs; recurring prices are plans.
			if ((price.config as { interval?: string }).interval !== "one_off") {
				continue;
			}
			const amount = priceAmountUsd(price);
			if (amount == null || amount <= 0) continue;
			if (!best || amount < best.amount) {
				best = { id: product.id, amount };
			}
		}
	}

	return best?.id ?? null;
};
