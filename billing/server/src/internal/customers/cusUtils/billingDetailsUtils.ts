import { ErrCode, RecaseError } from "@autumn/shared";

/**
 * Billing details (address, tax ids, custom invoice fields) are stored on the
 * billing processor's customer record. PayPal has no equivalent store, so
 * MeterPal cannot persist them.
 */
export const assertBillingDetailsWritable = () => {
	throw new RecaseError({
		message:
			"billing_details can't be set — they are stored on the billing processor's customer record, and PayPal has no equivalent.",
		code: ErrCode.InvalidRequest,
		statusCode: 400,
	});
};
