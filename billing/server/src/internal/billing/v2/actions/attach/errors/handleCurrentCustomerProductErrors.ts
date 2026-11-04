import {
	type AttachBillingContext,
	ErrCode,
	isCustomerProductPaid,
	RecaseError,
} from "@autumn/shared";

export const handleCurrentCustomerProductErrors = ({
	billingContext,
}: {
	billingContext: AttachBillingContext;
}) => {
	const {
		currentCustomerProduct,
		attachProduct,
		skipBillingChanges,
		skipExternalPSPGuard,
	} = billingContext;

	if (currentCustomerProduct?.product.id === attachProduct.id) {
		throw new RecaseError({
			code: ErrCode.PlanAlreadyAttached,
			message: `Cannot attach because the customer's current product '${currentCustomerProduct.product.name}' is the same as the product being attached`,
			statusCode: 409,
		});
	}

	// The "paid but no processor subscription" guard catches broken linkage.
	// External-origin callers that manage billing themselves (e.g. a wallet
	// top-up) legitimately have paid current products with no processor
	// subscription — they opt out via `skipExternalPSPGuard`. A customer
	// product with a linked subscription is explained linkage, not broken
	// linkage, so it passes too.
	if (
		!skipBillingChanges &&
		!skipExternalPSPGuard &&
		isCustomerProductPaid(currentCustomerProduct) &&
		!currentCustomerProduct?.subscription_ids?.length
	) {
		throw new RecaseError({
			message: `Cannot attach because the customer's current product '${currentCustomerProduct?.product.name}' is paid but no subscription is linked to it`,
		});
	}
};
