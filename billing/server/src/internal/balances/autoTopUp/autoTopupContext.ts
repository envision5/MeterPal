import type { Stripe } from "stripe";
import type {
	AutoTopup,
	AutoTopupLimitState,
	BillingContext,
	FullCusEntWithFullCusProduct,
	FullCustomer,
} from "@autumn/shared";

export interface AutoTopupContext extends BillingContext {
	autoTopupConfig: AutoTopup;
	customerEntitlement: FullCusEntWithFullCusProduct; // The one-off prepaid cusEnt being topped up

	limitState: AutoTopupLimitState;
}

/**
 * The fields the attempt-recording and webhook senders actually read.  The
 * PayPal auto top-up path has no Stripe billing context — it builds this
 * slim shape directly; the full AutoTopupContext satisfies it structurally,
 * so Stripe-path call sites are unchanged.
 */
export interface AutoTopupAttemptContext {
	fullCustomer: FullCustomer;
	autoTopupConfig: AutoTopup;
	customerEntitlement: FullCusEntWithFullCusProduct;
	limitState: AutoTopupLimitState;
	invoiceMode?: unknown;
	paymentMethod?: Stripe.PaymentMethod | null;
}
