import {
	type AttachParamsV1,
	type FullCusProduct,
	type FullCustomer,
	type FullProduct,
	resolveFreeTrialParam,
	type TrialContext,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import {
	applyProductTrialConfig,
	handleFreeTrialParam,
} from "@/internal/billing/v2/setup/trialContext";

/**
 * Sets up trial context for attach operations.
 *
 * Logic:
 * 1. If free_trial param passed → Use it (null removes trial, value sets fresh trial)
 * 2. Otherwise → Apply product's trial config with dedup
 */
export const setupAttachTrialContext = async ({
	ctx,
	params,
	currentContext,
}: {
	ctx: AutumnContext;
	params: AttachParamsV1;
	currentContext: {
		fullCustomer: FullCustomer;
		attachProduct: FullProduct;
		currentEpochMs: number;
		currentCustomerProduct?: FullCusProduct;
	};
}): Promise<TrialContext | undefined> => {
	const { fullCustomer, attachProduct, currentEpochMs, currentCustomerProduct } =
		currentContext;

	const freeTrialParams = resolveFreeTrialParam(params);
	if (freeTrialParams !== undefined) {
		return handleFreeTrialParam({
			freeTrialParams,
			customerProduct: currentCustomerProduct,
			fullProduct: attachProduct,
			currentEpochMs,
		});
	}

	// Apply product's trial config (upgrade or fresh attach) with dedup check
	return applyProductTrialConfig({
		ctx,
		fullProduct: attachProduct,
		fullCustomer,
		currentCustomerProduct,
		currentEpochMs,
	});
};
