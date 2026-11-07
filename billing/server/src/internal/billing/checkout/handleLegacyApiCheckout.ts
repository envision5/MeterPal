import {
	AffectedResource,
	ApiVersion,
	CheckoutParamsV0Schema,
	Scopes,
} from "@autumn/shared";
import { createRoute } from "../../../honoMiddlewares/routeHandler";
import { runCheckout } from "./runCheckout";
import { defaultTopUpProductId } from "./utils/defaultTopUpProduct";

export const handleLegacyApiCheckout = createRoute({
	scopes: [Scopes.Billing.Write],
	versionedBody: {
		latest: CheckoutParamsV0Schema,
		[ApiVersion.V1_Beta]: CheckoutParamsV0Schema,
	},
	resource: AffectedResource.Checkout,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const body = c.req.valid("json");

		// The paywall's topUp() names no product: fall back to the merchant's
		// cheapest one-off credit pack, so a 402 always has a way out.
		if (!body.product_id) {
			const topUpId = await defaultTopUpProductId({ ctx });
			if (topUpId) {
				(body as { product_id?: string }).product_id = topUpId;
			}
		}

		// The v2 attach pipeline keys the target on `plan_id`; the legacy V0
		// contract (SDK topUp(), the buyer agent) sends `product_id`.  Without
		// this mapping the pipeline looked up "Product undefined" and every
		// top-up 404'd.
		const checkoutRes = await runCheckout({
			ctx,
			checkoutParams: {
				...body,
				plan_id: body.product_id,
			} as typeof body,
		});

		return c.json(checkoutRes);
	},
});
