// billing/server/src/external/paypal/sales.ts
//
// Payments API v1 sale wrappers.  Recurring subscription cycles land as v1
// "sale" transactions (the PAYMENT.SALE.* webhooks carry a sale id), so a
// merchant-initiated refund of a cycle payment refunds the sale — not a
// capture, which is an Orders v2 concept.
//
// Spec: https://developer.paypal.com/api/payments/v1/#sale-refund

import type { PaypalClient } from "./paypalClient.js";
import { toUsd } from "./subscriptions.js";

export interface PayPalSaleRefund {
	id: string;
	status: string;
	amount?: { total: string; currency: string };
}

/**
 * Refunds a v1 sale (a subscription cycle payment), fully or partially.
 * Omitting `amountUsd` refunds the whole sale.
 *
 * The v1 refund body keys money as `{currency, value}` — unlike the v2
 * captures refund, which uses `currency_code`.
 */
export async function refundSale(
	client: PaypalClient,
	saleId: string,
	amountUsd?: number,
	note?: string,
): Promise<PayPalSaleRefund> {
	return client.fetch<PayPalSaleRefund>(`/v1/payments/sale/${saleId}/refund`, {
		method: "POST",
		body: JSON.stringify({
			...(amountUsd
				? { amount: { currency: "USD", value: toUsd(amountUsd) } }
				: {}),
			...(note ? { description: note.slice(0, 500) } : {}),
		}),
	});
}
