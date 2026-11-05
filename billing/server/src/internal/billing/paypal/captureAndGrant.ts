// billing/server/src/internal/billing/paypal/captureAndGrant.ts
//
// Capture a PayPal order and grant the wallet credits — the single money
// path shared by /paypal/return, /paypal/poll and /paypal/capture.
// Idempotent on the PayPal capture id: every caller can fire on the same
// payment and only one grant lands.  Callers must only ever pass the order
// the buyer is paying RIGHT NOW — no path sweeps the backlog of older
// intents, so one buyer approval can never turn into multiple charges.

import { paypalOrderIntents, type AppEnv } from "@autumn/shared";
import { eq } from "drizzle-orm";
import { db } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import {
	paypalCaptureInvoiceId,
	recordPaypalInvoice,
} from "@/external/paypal/invoiceRecording.js";
import { captureOrder } from "@/external/paypal/orders.js";
import {
	grantWalletCredits,
	resolveCustomer,
	stampPayerId,
} from "@/external/paypal/runPaypalWebhookHandlers.js";
import { getPaypalClientForOrg } from "./paypalOrgClient.js";

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
		// The order was created for one org, so that org's PayPal account is
		// the only one allowed to capture it — and that org also scopes the
		// customer-resolution fallbacks below (a buyer's email or payer id
		// may exist under another org).
		const [intent] = await db
			.select({
				org_id: paypalOrderIntents.org_id,
				env: paypalOrderIntents.env,
			})
			.from(paypalOrderIntents)
			.where(eq(paypalOrderIntents.order_id, orderId))
			.limit(1);
		if (!intent) {
			logger.error({ msg: "paypal capture: no org for order", orderId, via });
			return { status: "error", reason: "no_org" };
		}
		const client = await getPaypalClientForOrg(
			intent.org_id,
			intent.env as AppEnv,
		);
		if (!client) {
			logger.error({ msg: "paypal capture: no client for org", orderId, via });
			return { status: "error", reason: "no_org" };
		}

		const order = await client.fetch<Record<string, any>>(
			`/v2/checkout/orders/${orderId}`,
			{ method: "GET" },
		);

		let captureResource: Record<string, any> | undefined =
			order?.purchase_units?.[0]?.payments?.captures?.[0];

		if (order?.status === "APPROVED") {
			const capture = (await captureOrder(client, orderId)) as Record<
				string,
				any
			>;
			captureResource = capture?.purchase_units?.[0]?.payments?.captures?.[0];
		}

		if (!captureResource || captureResource.status !== "COMPLETED") {
			return {
				status:
					order?.status === "CREATED"
						? "pending"
						: `unapproved:${order?.status}`,
			};
		}

		const amount = parseFloat(captureResource.amount?.value ?? "0");
		const currency = (
			captureResource.amount?.currency_code ?? "USD"
		).toUpperCase();
		const captureId = captureResource.id;
		if (!captureId || !amount || currency !== "USD") {
			logger.error({
				msg: "paypal capture: unsupported",
				orderId,
				captureId,
				amount,
				currency,
			});
			return { status: "error", reason: "unsupported_capture" };
		}

		const customId: string | undefined = order?.purchase_units?.[0]?.custom_id;
		let customCustomerId: string | undefined;
		let customProductId: string | undefined;
		if (customId?.startsWith("mp:")) {
			// "mp:<customer_id>:<product_id>" — stamped at checkout creation.
			customCustomerId = customId.split(":")[1];
			customProductId = customId.split(":")[2];
		}

		const cust = await resolveCustomer({
			customId: customCustomerId,
			payerId:
				captureResource.payer?.payer_id ?? order?.payer?.payer_id ?? null,
			orgId: intent.org_id,
			email: captureResource.payer?.email_address ?? null,
		});
		if (!cust?.id) {
			logger.error({
				msg: "paypal capture: customer not found",
				orderId,
				customId,
			});
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
		await recordPaypalInvoice({
			customer: cust,
			externalId: paypalCaptureInvoiceId(captureId),
			amountUsd: amount,
			productId: customProductId,
			description: "PayPal credit pack",
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
		// Log the detail; return a generic reason — this response goes to
		// unauthenticated callers and raw PayPal error text is reconnaissance.
		logger.error({
			msg: "paypal capture: failed",
			orderId,
			via,
			error: String(err),
		});
		return { status: "error", reason: "capture_failed" };
	}
}
