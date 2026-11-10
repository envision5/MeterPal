// billing/server/src/external/paypal/orders.ts
//
// Orders v2 wrapper: create / capture / refund.  Used for one-shot credit
// top-ups (1k / 5k / 25k packs).
//
// Every call goes through the ORG's PayPal client.

import type { PaypalClient } from "./paypalClient.js";

export interface OrderCreateArgs {
	intent: "CAPTURE" | "AUTHORIZE";
	purchase_units: Array<{
		reference_id?: string;
		custom_id?: string;
		description?: string;
		invoice_id?: string;
		amount: {
			currency_code: string;
			value: string;
			breakdown?: { item_total?: { currency_code: string; value: string } };
		};
		items?: Array<{
			name: string;
			sku?: string;
			quantity: string;
			unit_amount: { currency_code: string; value: string };
			category?: "DIGITAL_GOODS" | "PHYSICAL_GOODS";
		}>;
	}>;
	payment_source?: {
		paypal?: {
			/**
			 * The buyer's approved billing agreement (BA-...) — charging against it
			 * needs no buyer presence (merchant-initiated transaction).  Spec:
			 * "The PayPal billing agreement ID. References an approved recurring
			 * payment for goods or services."
			 */
			billing_agreement_id?: string;
			/** A payment source stored in the PayPal vault (Payment Method Tokens). */
			vault_id?: string;
			/** Marks the charge as merchant-initiated / subsequent use for PayPal risk. */
			stored_credential?: {
				payment_initiator: "CUSTOMER" | "MERCHANT";
				usage?: "FIRST" | "SUBSEQUENT" | "DERIVED";
			};
			experience_context?: {
				shipping_preference?: string;
				user_action?: string;
				brand_name?: string;
				locale?: string;
				/** Where PayPal sends the buyer's browser after approval.  Without
				 *  this the merchant account's default is used (or nothing), and
				 *  the buyer gets stuck on the PayPal payment page in a loop. */
				return_url?: string;
				cancel_url?: string;
			};
		};
	};
}

export interface OrderResponse {
	id: string;
	status: string;
	links: Array<{ href: string; rel: string; method?: string }>;
}

export async function createOrder(
	client: PaypalClient,
	args: OrderCreateArgs,
	opts: { idempotencyKey?: string } = {},
): Promise<OrderResponse> {
	return client.fetch<OrderResponse>("/v2/checkout/orders", {
		method: "POST",
		body: JSON.stringify(args),
		idempotencyKey: opts.idempotencyKey,
	});
}

export async function captureOrder(
	client: PaypalClient,
	orderId: string,
): Promise<OrderResponse> {
	return client.fetch<OrderResponse>(`/v2/checkout/orders/${orderId}/capture`, {
		method: "POST",
		body: "{}",
		headers: { Prefer: "return=representation" },
	});
}

export async function refundCapture(
	client: PaypalClient,
	captureId: string,
	amount?: { currency_code: string; value: string },
	note?: string,
): Promise<{ id: string; status: string }> {
	return client.fetch(`/v2/payments/captures/${captureId}/refund`, {
		method: "POST",
		body: JSON.stringify({
			amount,
			note_to_payer: note,
		}),
	});
}
