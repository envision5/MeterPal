// billing/server/src/internal/customers/handlers/handleRefundInvoice/refundPaypalInvoice.ts
//
// The PayPal branch of POST /v1/customers/:customer_id/invoices/:processor_invoice_id/refund.
//
// PayPal invoices are recorded with namespaced external ids (pp-cap-... /
// pp-sale-... / pp-inv-...), and the instrument named there is what gets
// refunded:
//   capture (Orders v2)  -> POST /v2/payments/captures/{capture_id}/refund
//   sale (v1 cycle pay)  -> POST /v1/payments/sale/{sale_id}/refund
//
// The wallet correction and the invoices.refunded_amount increment use the
// SAME idempotency keys the PAYMENT.*.REFUNDED webhook handler uses
// (`paypal-refund:<refundId>`), so:
//   - locally (no webhook tunnel), the refund lands immediately, and
//   - when PayPal delivers the webhook afterwards, the replay is a no-op —
//     the refund is never double-counted.

import type { Invoice } from "@autumn/shared";
import { ErrCode, RecaseError } from "@autumn/shared";
import { paypalInvoiceInstrument } from "@/external/paypal/invoiceRecording.js";
import { refundCapture } from "@/external/paypal/orders.js";
import { getPaypalClient } from "@/external/paypal/paypalClient.js";
import {
	grantWalletCredits,
	incrementPaypalInvoiceRefund,
} from "@/external/paypal/runPaypalWebhookHandlers.js";
import { refundSale } from "@/external/paypal/sales.js";
import { toUsd } from "@/external/paypal/subscriptions.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { getPaypalCustomer } from "@/internal/billing/paypal/paypalSubscriptionLifecycle.js";

export const refundPaypalInvoice = async ({
	ctx,
	invoice,
	customerId,
	mode,
	amount,
	reason,
}: {
	ctx: AutumnContext;
	/** The invoices row behind a pp-* external id. */
	invoice: Invoice;
	customerId: string;
	mode: "full" | "partial";
	amount?: number;
	reason?: string;
}) => {
	const { org, env } = ctx;

	// Raw customer row (the PayPal billing paths live on its table columns).
	const customer = await getPaypalCustomer({ ctx, customerId });
	if (invoice.internal_customer_id !== customer.internal_id) {
		throw new RecaseError({
			message: "Invoice not found for this customer",
			code: ErrCode.InvalidRequest,
			statusCode: 404,
		});
	}

	const instrument = paypalInvoiceInstrument(invoice.processor_invoice_id);
	if (!instrument || instrument.instrument === "invoice") {
		// PayPal Invoicing API payments are refunded through PayPal's invoice
		// flows (INVOICING.*), not the payments refund endpoints.
		throw new RecaseError({
			message:
				"This PayPal invoice type cannot be refunded via MeterPal — refund it from your PayPal dashboard.",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	const paidAmount = Math.abs(invoice.amount_paid ?? invoice.total);
	const remainingRefundable = paidAmount - invoice.refunded_amount;
	if (remainingRefundable <= 0) {
		throw new RecaseError({
			message: "This invoice has already been fully refunded",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	let refundAmount = remainingRefundable;
	if (mode === "partial") {
		if (!amount || amount <= 0) {
			throw new RecaseError({
				message: "Amount is required for partial refunds",
				code: ErrCode.InvalidRequest,
				statusCode: 400,
			});
		}
		if (amount > remainingRefundable) {
			throw new RecaseError({
				message: `Refund amount exceeds the refundable balance of ${toUsd(remainingRefundable)} USD`,
				code: ErrCode.InvalidRequest,
				statusCode: 400,
			});
		}
		refundAmount = amount;
	}

	const client = await getPaypalClient({ org, env });

	const refund =
		instrument.instrument === "capture"
			? await refundCapture(
					client,
					instrument.externalId,
					{ currency_code: "USD", value: toUsd(refundAmount) },
					reason ?? "Refunded via MeterPal",
				)
			: await refundSale(
					client,
					instrument.externalId,
					refundAmount,
					reason ?? "Refunded via MeterPal",
				);

	// Wallet correction with the webhook's idempotency key: applies now
	// (works without a webhook tunnel) and makes the later webhook replay a
	// no-op, so the refund is corrected exactly once.
	const grantApplied = await grantWalletCredits({
		customer,
		amountUsd: -refundAmount,
		idempotencyKey: `paypal-refund:${refund.id}`,
		eventName: "refund",
		metadata: {
			via: "merchant_refund_endpoint",
			[instrument.instrument === "capture" ? "capture_id" : "sale_id"]:
				instrument.externalId,
		},
	});

	if (grantApplied) {
		await incrementPaypalInvoiceRefund({
			externalId: invoice.processor_invoice_id,
			amountUsd: refundAmount,
		});
	}

	ctx.logger.info("paypal: refund issued", {
		refundId: refund.id,
		invoiceId: invoice.id,
		instrument: instrument.instrument,
		refundAmount,
		customerId: customer.id,
	});

	return {
		processor: "paypal",
		refund_id: refund.id,
		amount: refundAmount,
		currency: "USD",
		status: refund.status ?? "completed",
	};
};
