import { ErrCode, type FullCusProduct, RecaseError } from "@autumn/shared";
import { StatusCodes } from "http-status-codes";

/**
 * Backdating starts a brand-new processor subscription at the backdated date.
 * Any existing subscription/scheduled product means the processor would prorate
 * instead, so a past starts_at can't be honored — reject before billing runs.
 */
export const assertNoBackdateWithExistingSubscription = ({
	billingContext,
	subject = "Past starts_at",
}: {
	billingContext: {
		currentCustomerProduct?: FullCusProduct;
		scheduledCustomerProduct?: FullCusProduct;
	};
	subject?: string;
}) => {
	if (
		billingContext.currentCustomerProduct?.subscription_ids?.length ||
		billingContext.scheduledCustomerProduct
	) {
		throw new RecaseError({
			message: `${subject} is only supported when creating a new subscription.`,
			code: ErrCode.InvalidRequest,
			statusCode: StatusCodes.BAD_REQUEST,
		});
	}
};
