// billing/server/src/internal/customers/handlers/handleRefundInvoice/handleRefundInvoice.ts
//
// PayPal is the only billing processor, so every refund goes through PayPal.
// The processor invoice id in the route is the external id PayPal handed back
// (pp-cap-... / pp-sale-... / pp-inv-...), which names the instrument to refund.

import { ErrCode, RecaseError, Scopes } from "@autumn/shared";
import { z } from "zod/v4";
import { isPaypalInvoiceId } from "@/external/paypal/invoiceRecording.js";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { InvoiceService } from "@/internal/invoices/InvoiceService.js";
import { refundPaypalInvoice } from "./refundPaypalInvoice.js";

const RefundInvoiceBodySchema = z.object({
	mode: z.enum(["full", "partial"]),
	amount: z.number().positive().optional(),
	reason: z.string().optional(),
});

export const handleRefundInvoice = createRoute({
	scopes: [Scopes.Billing.Write],
	params: z.object({
		customer_id: z.string(),
		processor_invoice_id: z.string(),
	}),
	body: RefundInvoiceBodySchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { customer_id, processor_invoice_id } = c.req.param();
		const { mode, amount, reason } = c.req.valid("json");

		if (!isPaypalInvoiceId(processor_invoice_id)) {
			throw new RecaseError({
				message: "Invoice not found",
				code: ErrCode.InvalidRequest,
				statusCode: 404,
			});
		}

		const paypalInvoice = await InvoiceService.getByProcessorInvoiceId({
			db: ctx.db,
			processorInvoiceId: processor_invoice_id,
		});
		if (!paypalInvoice) {
			throw new RecaseError({
				message: "Invoice not found",
				code: ErrCode.InvalidRequest,
				statusCode: 404,
			});
		}

		const response = await refundPaypalInvoice({
			ctx,
			invoice: paypalInvoice,
			customerId: customer_id,
			mode,
			amount,
			reason,
		});
		return c.json(response);
	},
});
