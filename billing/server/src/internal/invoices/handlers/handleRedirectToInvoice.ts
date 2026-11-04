import { ErrCode, RecaseError, Scopes } from "@autumn/shared";
import { StatusCodes } from "http-status-codes";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { InvoiceService } from "../InvoiceService.js";

/**
 * Redirect to the invoice's hosted URL (PayPal Invoicing), stored on the row.
 * Public route - no authentication required. Authorisation comes from
 * possession of the opaque invoice ID in the URL.
 */
export const handleRedirectToInvoice = createRoute({
	scopes: [Scopes.Public],
	handler: async (c) => {
		const { db } = c.get("ctx");
		const { invoiceId } = c.req.param();

		const invoice = await InvoiceService.get({
			db,
			id: invoiceId,
		});

		if (!invoice) {
			throw new RecaseError({
				message: "Invoice not found",

				statusCode: StatusCodes.NOT_FOUND,
			});
		}

		if (!invoice.hosted_invoice_url) {
			throw new RecaseError({
				message: "This invoice has no hosted invoice URL",
				code: ErrCode.InvalidRequest,
				statusCode: StatusCodes.NOT_FOUND,
			});
		}

		return c.redirect(invoice.hosted_invoice_url);
	},
});
