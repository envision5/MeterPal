import type { BillingContext, FullCusProduct } from "@autumn/shared";
import { isCustomerProductTrialing } from "@autumn/shared";
import { billingContextHasTrial } from "./billingContextHasTrial";

/** Gets the trial state transition for a billing context. */
export const getTrialStateTransition = ({
	billingContext,
}: {
	billingContext: BillingContext & {
		currentCustomerProduct?: FullCusProduct;
		customerProduct?: FullCusProduct;
	};
}) => {
	// The trial state lives on the customer product row — the v2 engine never
	// holds a processor subscription.
	const customerProduct =
		billingContext.currentCustomerProduct ?? billingContext.customerProduct;

	const isTrialing = !!isCustomerProductTrialing(customerProduct, {
		nowMs: billingContext.currentEpochMs,
	});

	const willBeTrialing = billingContextHasTrial({ billingContext, isTrialing });

	return { isTrialing, willBeTrialing };
};
