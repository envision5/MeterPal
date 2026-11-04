import type { BillingContext, FullCusProduct } from "@autumn/shared";

export const getCurrentBillingCycleAnchorMs = ({
	billingContext,
}: {
	billingContext: BillingContext & { customerProduct?: FullCusProduct };
}) => {
	// The anchor lives on the customer product row — the v2 engine never holds a
	// processor subscription.
	const billingCycleAnchorMs = billingContext.customerProduct?.billing_cycle_anchor;

	return billingCycleAnchorMs ?? "now";
};
