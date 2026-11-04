import {
	type AttachBillingContext,
	type AutumnBillingPlan,
	BillingInterval,
	ErrCode,
	type FullProduct,
	isFreeProduct,
	RecaseError,
} from "@autumn/shared";

/**
 * Gets unique recurring intervals from line items (excludes one-off prices).
 */
const getRecurringIntervalsFromPaidLineItems = ({
	autumnBillingPlan,
}: {
	autumnBillingPlan: AutumnBillingPlan;
}): Set<string> => {
	const intervals = new Set<string>();

	for (const lineItem of autumnBillingPlan.lineItems ?? []) {
		const price = lineItem.context.price;
		const interval = price.config.interval;

		// Skip one-off prices
		if (interval === BillingInterval.OneOff) continue;
		if (lineItem.amountAfterDiscounts <= 0) continue;

		// Create a unique key for interval + interval_count
		const intervalCount = price.config.interval_count ?? 1;
		const key = `${interval}_${intervalCount}`;
		intervals.add(key);
	}

	return intervals;
};

const hasPaidPlanLicense = ({ product }: { product: FullProduct }) =>
	(product.licenses ?? []).some(
		(planLicense) => !isFreeProduct({ product: planLicense.product }),
	);

const billingPlanPurchasesPaidLicense = ({
	autumnBillingPlan,
}: {
	autumnBillingPlan: AutumnBillingPlan;
}) =>
	(autumnBillingPlan.insertCustomerProducts ?? []).some((customerProduct) =>
		(customerProduct.customer_licenses ?? []).some(
			(customerLicense) =>
				customerLicense.paid_quantity > 0 &&
				customerLicense.planLicense !== null &&
				!isFreeProduct({
					product: customerLicense.planLicense.product,
				}),
		),
	);

const handleProcessorCheckoutLicenseErrors = ({
	billingContext,
	autumnBillingPlan,
}: {
	billingContext: AttachBillingContext;
	autumnBillingPlan: AutumnBillingPlan;
}) => {
	const { attachProduct, currentCustomerProduct } = billingContext;
	if (currentCustomerProduct) return;
	if (!isFreeProduct({ prices: attachProduct.prices })) return;
	if (!hasPaidPlanLicense({ product: attachProduct })) return;
	if (billingPlanPurchasesPaidLicense({ autumnBillingPlan })) return;

	throw new RecaseError({
		message:
			"Processor checkout requires at least one license quantity above its included quantity.",
		code: ErrCode.InvalidRequest,
		statusCode: 400,
	});
};

/**
 * Validates that processor checkout mode can carry the plan.
 *
 * A processor checkout (PayPal approval) can only bill one recurring interval
 * at a time, and it collects payment up front — so a plan that mixes intervals
 * or that needs a paid license on top of a free price cannot be checked out.
 */
export const handleProcessorCheckoutErrors = ({
	billingContext,
	autumnBillingPlan,
}: {
	billingContext: AttachBillingContext;
	autumnBillingPlan: AutumnBillingPlan;
}) => {
	// Only check for processor_checkout mode
	if (billingContext.checkoutMode !== "processor_checkout") return;

	handleProcessorCheckoutLicenseErrors({ billingContext, autumnBillingPlan });

	const recurringIntervals = getRecurringIntervalsFromPaidLineItems({
		autumnBillingPlan,
	});

	// If we have more than one unique recurring interval, throw an error
	if (recurringIntervals.size > 1) {
		throw new RecaseError({
			message:
				"Cannot create a processor checkout when there are multiple intervals that require payment upfront. Please use direct billing or separate the purchases.",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	// enable_plan_immediately pre-inserts the cusProduct (with its feature
	// quantities) at attach time. If the customer can change quantities on the
	// checkout page, those changes won't propagate back to the row,
	// leaving Autumn out of sync with the processor. Block the combination explicitly.
	if (
		billingContext.enablePlanImmediately &&
		(billingContext.adjustableFeatureQuantities?.length ?? 0) > 0
	) {
		throw new RecaseError({
			message:
				"enable_plan_immediately cannot be used with adjustable feature quantities — set adjustable_quantity to false on each option, or remove enable_plan_immediately.",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}
};
