import type { FullCustomer, FullProduct } from "@autumn/shared";
import type { AttachParams } from "@/internal/customers/cusProducts/AttachParams.js";
import { getFreeTrialAfterFingerprint } from "@/internal/products/free-trials/freeTrialUtils.js";
import type { AutumnContext } from "../../../../../honoUtils/HonoEnv.js";

/**
 * Builds the attach params a check preview needs.
 *
 * The billing engine is DB-only, so there is no processor customer or payment
 * method to resolve here — only the customer's free-trial eligibility.
 */
export const checkToAttachParams = async ({
	ctx,
	customer,
	product,
}: {
	ctx: AutumnContext;
	customer: FullCustomer;
	product: FullProduct;
}) => {
	const { org, db } = ctx;

	const freeTrial = await getFreeTrialAfterFingerprint({
		db,
		freeTrial: product.free_trial,
		fingerprint: customer.fingerprint,
		internalCustomerId: customer.internal_id,
		internalEntityId: customer.entity?.internal_id,
		multipleAllowed: org.config.multiple_trials,
		productId: product.id,
	});

	const attachParams: AttachParams = {
		now: Date.now(),

		customer,
		products: [product],
		optionsList: [],
		prices: product.prices,
		entitlements: product.entitlements,
		freeTrial,
		replaceables: [],

		// Others
		req: ctx,
		org: ctx.org,
		entities: customer.entities,
		features: ctx.features,
		internalEntityId: customer.entity?.internal_id,
		cusProducts: customer.customer_products,
	};

	return attachParams;
};
