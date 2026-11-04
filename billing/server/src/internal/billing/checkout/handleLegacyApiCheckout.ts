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

		const checkoutRes = await runCheckout({ ctx, checkoutParams: body });

		return c.json(checkoutRes);
	},
});
