import { ErrCode, type FullCustomer, RecaseError } from "@autumn/shared";
import { StatusCodes } from "http-status-codes";

/** Invoice mode delivers the invoice by email, so an email is required. */
export const handleInvoiceModeEmailErrors = ({
	fullCustomer,
}: {
	fullCustomer: FullCustomer;
}) => {
	const hasEmail = Boolean(fullCustomer.email?.trim());
	if (hasEmail) return;

	throw new RecaseError({
		message:
			`Customer ${fullCustomer.id ?? fullCustomer.internal_id} has no email. ` +
			"Invoice mode sends the invoice by email — set an email on the customer first.",
		code: ErrCode.InvalidRequest,
		statusCode: StatusCodes.BAD_REQUEST,
	});
};
