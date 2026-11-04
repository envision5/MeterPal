import type {
	FreeTrialParamsSource,
	FullCusProduct,
	FullProduct,
	TrialContext,
} from "@autumn/shared";
import {
	isCustomerProductRevertingTrial,
	resolveFreeTrialParam,
} from "@autumn/shared";
import {
	handleFreeTrialParam,
	inheritTrialFromCustomerProduct,
} from "@/internal/billing/v2/setup/trialContext";

/**
 * Sets up trial context for update subscription operations.
 *
 * Logic:
 * 1. If a free_trial param passed (customize.free_trial or the shorthand) → Use it (null removes trial, value sets fresh trial)
 * 2. If revert trial → Inherit from customer product (its subscription belongs to the paused plan)
 * 3. If the customer product carries a trial → Inherit from customer product
 * 4. Otherwise → No trial context
 */
export const setupUpdateSubscriptionTrialContext = ({
	customerProduct,
	currentEpochMs,
	params,
	fullProduct,
}: {
	customerProduct?: FullCusProduct;
	currentEpochMs: number;
	fullProduct: FullProduct;
	params: FreeTrialParamsSource;
}): TrialContext | undefined => {
	const isRevertTrial = isCustomerProductRevertingTrial(customerProduct);

	// Handle explicit free_trial param (null or value), in either shape
	const freeTrialParam = resolveFreeTrialParam(params);
	if (freeTrialParam !== undefined) {
		const trialContext = handleFreeTrialParam({
			freeTrialParams: freeTrialParam,
			customerProduct,
			fullProduct,
			currentEpochMs,
		});

		if (!trialContext || !isRevertTrial) return trialContext;
		return { ...trialContext, onEnd: trialContext.onEnd ?? "revert" };
	}

	if (customerProduct && isRevertTrial) {
		return inheritTrialFromCustomerProduct({ customerProduct, currentEpochMs });
	}

	// Inherit from the customer product's stored trial state
	if (customerProduct) {
		return inheritTrialFromCustomerProduct({ customerProduct, currentEpochMs });
	}

	return undefined;
};
