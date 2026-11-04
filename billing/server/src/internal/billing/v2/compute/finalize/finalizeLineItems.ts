import {
	type AutumnBillingPlan,
	type BillingContext,
	type CustomLineItem,
	filterUnchangedPricesFromLineItems,
	type FullCusProduct,
	type LineItem,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { buildSharedSubscriptionTrialLineItems } from "@/internal/billing/v2/compute/computeAutumnUtils/buildSharedSubscriptionTrialLineItems";
import { filterLineItemsForTrialTransition } from "@/internal/billing/v2/compute/computeAutumnUtils/filterLineItemsForTrialTransition";

/**
 * Finalizes line items for a billing plan by:
 * 1. If custom line items are provided, overrides computed line items entirely
 * 2. Filtering line items based on trial state transitions
 * 3. Filtering out unchanged prices (refund + charge pairs that cancel out)
 * 4. Adding line items for sibling products affected by trial state changes
 */
export const finalizeLineItems = ({
	ctx,
	lineItems,
	billingContext,
	autumnBillingPlan,
	customLineItems,
}: {
	ctx: AutumnContext;
	lineItems: LineItem[];
	billingContext: BillingContext & {
		currentCustomerProduct?: FullCusProduct;
		customerProduct?: FullCusProduct;
	};
	autumnBillingPlan: AutumnBillingPlan;
	customLineItems?: CustomLineItem[];
}): LineItem[] => {
	if (billingContext.skipBillingChanges) {
		return [];
	}

	const customerProduct =
		billingContext.currentCustomerProduct ?? billingContext.customerProduct;

	if (
		billingContext.requestedProrationBehavior === "none" &&
		customerProduct?.subscription_ids?.length &&
		!billingContext.anchorResetRefund?.noPartialRefund
	) {
		return [];
	}

	// 0. If custom line items provided, override computed line items entirely
	if (customLineItems?.length) {
		autumnBillingPlan.customLineItems = customLineItems;
		return [];
	}

	// 1. Filter line items based on trial state transitions
	let finalizedLineItems = filterLineItemsForTrialTransition({
		ctx,
		lineItems,
		billingContext,
	});

	// 2. Filter out unchanged prices (refund + charge pairs that cancel out)
	finalizedLineItems = filterUnchangedPricesFromLineItems({
		lineItems: finalizedLineItems,
	});

	// 3. Add line items for sibling products affected by trial state changes
	const sharedTrialLineItems = buildSharedSubscriptionTrialLineItems({
		ctx,
		billingContext,
		autumnBillingPlan,
	});
	finalizedLineItems = [...finalizedLineItems, ...sharedTrialLineItems];

	return finalizedLineItems;
};
