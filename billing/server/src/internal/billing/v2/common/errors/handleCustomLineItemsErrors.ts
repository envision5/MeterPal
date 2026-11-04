import type {
	BillingContext,
	BillingPlan,
	CustomLineItem,
	FullCusProduct,
} from "@autumn/shared";
import { ErrCode, RecaseError } from "@autumn/shared";
import { getTrialStateTransition } from "@/internal/billing/v2/utils/billingContext/getTrialStateTransition";

/**
 * A billing plan that updates an existing customer product (rather than
 * creating one) is the DB-only stand-in for a processor "subscription update".
 */
export const isSubscriptionUpdatePlan = (billingPlan: BillingPlan) =>
	billingPlan.autumn.updateCustomerProduct !== undefined ||
	(billingPlan.autumn.updateCustomerProducts?.length ?? 0) > 0;

/**
 * Validates that custom_line_items is only used in valid scenarios:
 * 1. The plan must update an existing subscription (not create one)
 * 2. The update must not create a processor-managed invoice (e.g. trial removal)
 */
export const handleCustomLineItemsErrors = ({
	params,
	billingContext,
	billingPlan,
}: {
	params: { custom_line_items?: CustomLineItem[] };
	billingContext: BillingContext & {
		currentCustomerProduct?: FullCusProduct;
		customerProduct?: FullCusProduct;
	};
	billingPlan: BillingPlan;
}) => {
	if (!params.custom_line_items?.length) return;

	// 1. Only allowed for subscription updates (not creates, cancels, etc.)
	if (!isSubscriptionUpdatePlan(billingPlan)) {
		throw new RecaseError({
			message:
				"custom_line_items can only be used when updating an existing subscription (not creating a new one)",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	// 2. Not allowed when the update creates a processor-managed invoice (trial removal)
	const { isTrialing, willBeTrialing } = getTrialStateTransition({
		billingContext,
	});

	if (isTrialing && !willBeTrialing) {
		throw new RecaseError({
			message:
				"custom_line_items cannot be used when the subscription update creates a processor-managed invoice (e.g. removing a trial)",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}
};
