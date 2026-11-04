import type { CheckoutMode, InvoiceMode, TrialContext } from "@autumn/shared";
import {
	type FullProduct,
	isFreeProduct,
	isOneOffProduct,
	type RedirectMode,
} from "@autumn/shared";

/**
 * Determines the checkout mode for attach operations.
 *
 * PayPal is the only billing processor: paid products that need the buyer's
 * approval return "processor_checkout" (PayPal order/subscription approval).
 */
export const setupAttachCheckoutMode = ({
	redirectMode,
	attachProduct,
	trialContext,
	invoiceMode,
	hasFutureStartDate,
}: {
	redirectMode?: RedirectMode;
	attachProduct: FullProduct;
	trialContext?: TrialContext;
	invoiceMode?: InvoiceMode;
	hasFutureStartDate?: boolean;
}): CheckoutMode => {
	const productIsOneOff = isOneOffProduct({ product: attachProduct });
	const productIsFree = isFreeProduct({ product: attachProduct });
	const productIsPaidRecurring = !productIsOneOff && !productIsFree;

	if (redirectMode === "never") {
		return null;
	}

	if (invoiceMode) {
		return null;
	}

	if (hasFutureStartDate) {
		return null;
	}

	const getProcessorCheckoutOrDirectBilling = (): CheckoutMode => {
		if (productIsOneOff) return "processor_checkout";

		if (productIsPaidRecurring) {
			// If trial requires no card, direct billing
			if (trialContext?.trialEndsAt && trialContext?.cardRequired === false) {
				return null;
			}
			return "processor_checkout";
		}

		return null;
	};

	const checkoutMode = getProcessorCheckoutOrDirectBilling();

	if (checkoutMode === null && redirectMode === "always") {
		// 1. If it's one off product, return processor_checkout
		if (productIsOneOff) return "processor_checkout";

		// 2. If it's paid recurring, return processor_checkout
		if (productIsPaidRecurring) {
			return "processor_checkout";
		}

		return "autumn_checkout";
	}

	return checkoutMode;
};
