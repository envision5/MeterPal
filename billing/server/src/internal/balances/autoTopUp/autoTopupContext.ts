import type {
	AutoTopup,
	AutoTopupLimitState,
	FullCusEntWithFullCusProduct,
	FullCustomer,
} from "@autumn/shared";

/**
 * The fields the attempt-recording and webhook senders actually read. The
 * PayPal executor builds this directly. `paymentMethod` is the fingerprintable
 * instrument id (PayPal billing agreement token) — used by the durable
 * circuit breaker so a fresh instrument gets a fresh chance.
 */
export interface AutoTopupAttemptContext {
	fullCustomer: FullCustomer;
	autoTopupConfig: AutoTopup;
	customerEntitlement: FullCusEntWithFullCusProduct;
	limitState: AutoTopupLimitState;
	invoiceMode?: unknown;
	paymentMethod?: string | null;
}
