import type { BillingContext, BillingResult } from "@autumn/shared";
import {
	type BillingResponse,
	type Checkout,
	CheckoutAction,
	checkoutToUrl,
} from "@autumn/shared";

const isLongLivedCheckout = (checkout: Checkout) =>
	checkout.action === CheckoutAction.Attach &&
	"long_lived_checkout" in checkout.params &&
	checkout.params.long_lived_checkout === true;

export const billingResultToResponse = ({
	billingContext,
	billingResult,
}: {
	billingContext: BillingContext;
	billingResult: BillingResult;
}): BillingResponse => {
	const { fullCustomer } = billingContext;

	const customerId = fullCustomer.id ?? fullCustomer.internal_id;

	const invoice = billingResult.processor?.autumnInvoice;
	const checkoutUrl = billingResult.processor?.checkoutUrl;
	const autumnCheckout = billingResult.autumn?.checkout;

	// Autumn checkout URL takes priority, then the processor checkout URL,
	// then the invoice hosted URL
	const paymentUrl = autumnCheckout
		? checkoutToUrl({
				action: autumnCheckout.action,
				checkoutId: autumnCheckout.id,
				longLived: isLongLivedCheckout(autumnCheckout),
			})
		: (checkoutUrl ??
			(invoice?.status === "open" ? (invoice.hosted_invoice_url ?? null) : null));

	return {
		customer_id: customerId,
		entity_id: fullCustomer.entity?.id ?? undefined,
		invoice: invoice
			? {
					status: invoice.status ?? null,
					processor_invoice_id: invoice.processor_invoice_id,
					total: invoice.total,
					currency: invoice.currency,
					hosted_invoice_url: invoice.hosted_invoice_url ?? null,
				}
			: undefined,
		payment_url: paymentUrl,
		required_action: billingResult.processor?.requiredAction,
	} satisfies BillingResponse;
};
