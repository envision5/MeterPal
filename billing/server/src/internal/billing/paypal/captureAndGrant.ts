// billing/server/src/internal/billing/paypal/captureAndGrant.ts
//
// Capture a PayPal order and grant the wallet credits — the single money
// path shared by /paypal/return, /paypal/poll, /paypal/capture and the
// checkout abandonment sweep.  Idempotent on the PayPal capture id: every
// caller can fire on the same payment and only one grant lands.

import { eq } from "drizzle-orm";
import { paypalOrderIntents } from "@autumn/shared";
import { db } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import { paypalFetch } from "@/external/paypal/client.js";
import { captureOrder } from "@/external/paypal/orders.js";
import {
	grantWalletCredits,
	resolveCustomer,
	stampPayerId,
} from "@/external/paypal/runPaypalWebhookHandlers.js";

/**
 * Capture an order (if approved) and grant the wallet credits.  Shared by
 * /paypal/return, /paypal/poll and /paypal/capture — idempotent on the
 * capture id, so every path can fire without double-granting.
 */
export async function captureAndGrant(
	orderId: string,
	via: string,
): Promise<{ status: string; credits?: number; reason?: string }> {
	try {
		const order = await paypalFetch<Record<string, any>>(
			`/v2/checkout/orders/${orderId}`,
			{ method: "GET" },
		);

		let captureResource: Record<string, any> | undefined =
			order?.purchase_units?.[0]?.payments?.captures?.[0];

		if (order?.status === "APPROVED") {
			const capture = (await captureOrder(orderId)) as Record<string, any>;
			captureResource = capture?.purchase_units?.[0]?.payments?.captures?.[0];
		}

		if (!captureResource || captureResource.status !== "COMPLETED") {
			return { status: order?.status === "CREATED" ? "pending" : `unapproved:${order?.status}` };
		}

		const amount = parseFloat(captureResource.amount?.value ?? "0");
		const currency = (captureResource.amount?.currency_code ?? "USD").toUpperCase();
		const captureId = captureResource.id;
		if (!captureId || !amount || currency !== "USD") {
			logger.error({ msg: "paypal capture: unsupported", orderId, captureId, amount, currency });
			return { status: "error", reason: "unsupported_capture" };
		}

		const customId: string | undefined =
			order?.purchase_units?.[0]?.custom_id;
		let customCustomerId: string | undefined;
		if (customId?.startsWith("mp:")) customCustomerId = customId.split(":")[1];

		const cust = await resolveCustomer({
			customId: customCustomerId,
			payerId: captureResource.payer?.payer_id ?? order?.payer?.payer_id ?? null,
			email: captureResource.payer?.email_address ?? null,
		});
		if (!cust?.id) {
			logger.error({ msg: "paypal capture: customer not found", orderId, customId });
			return { status: "error", reason: "no_customer" };
		}

		await stampPayerId(cust.id, captureResource.payer?.payer_id ?? null);
		await grantWalletCredits({
			customer: cust,
			amountUsd: amount,
			idempotencyKey: `paypal-capture:${captureId}`,
			eventName: "wallet_topup",
			metadata: { capture_id: captureId, order_id: orderId, via },
		});

		// Mark any intent row captured (best-effort).
		await db
			.update(paypalOrderIntents)
			.set({ status: "captured" })
			.where(eq(paypalOrderIntents.order_id, orderId));

		logger.info({
			msg: "paypal: captured and credited",
			orderId,
			captureId,
			amount,
			customerId: cust.id,
			via,
		});
		return { status: "captured", credits: amount };
	} catch (err) {
		logger.error({ msg: "paypal capture: failed", orderId, via, error: String(err) });
		return { status: "error", reason: String(err).slice(0, 200) };
	}
}

