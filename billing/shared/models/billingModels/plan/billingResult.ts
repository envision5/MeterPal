import type { Checkout, Invoice, PaymentFailureCode } from "@autumn/shared";

export interface ProcessorBillingResult {
	deferred?: boolean;
	deferredMetadataId?: string;
	/** An earlier pending plan's open invoice was returned; this request was not applied. */
	resumedPendingInvoice?: boolean;
	/** Processor checkout the customer must complete (PayPal approval URL). */
	checkoutUrl?: string | null;
	/** Processor id of the created checkout (PayPal order/subscription id). */
	checkoutId?: string;
	requiredAction?: {
		code: PaymentFailureCode;
		reason: string;
	};
	autumnInvoice?: Invoice;
}

export interface AutumnBillingResult {
	checkout?: Checkout;
}

export interface BillingResult {
	processor?: ProcessorBillingResult;
	autumn?: AutumnBillingResult;
}
