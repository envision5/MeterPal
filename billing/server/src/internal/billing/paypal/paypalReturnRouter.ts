// billing/server/src/internal/billing/paypal/paypalReturnRouter.ts
//
// Browser-return handler for PayPal Orders v2 checkouts.
//
// Flow: buyer approves on PayPal -> PayPal redirects their browser here
// (?token=<order_id>) -> we CAPTURE the order server-side (in Orders v2 the
// merchant captures after approval) -> grant the wallet credits (idempotent
// on the capture id, the SAME key the /webhooks/paypal handler uses, so the
// two paths never double-grant) -> redirect to the app.
//
// This closes the payment loop for LOCAL development without a public
// webhook URL; the webhook remains the hosted-production path.
//
// Env: METERPAL_CHECKOUT_RETURN_URL (app landing page after capture,
//      default http://localhost:5173)

import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { customers, paypalOrderIntents } from "@autumn/shared";
import { db } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import { paypalFetch } from "@/external/paypal/client.js";
import { captureOrder } from "@/external/paypal/orders.js";
import {
	grantWalletCredits,
	resolveCustomer,
	stampPayerId,
} from "@/external/paypal/runPaypalWebhookHandlers.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";

export const paypalReturnRouter = new Hono<HonoEnv>();

/**
 * Capture an order (if approved) and grant the wallet credits.  Shared by
 * /paypal/return, /paypal/poll and /paypal/capture — idempotent on the
 * capture id, so every path can fire without double-granting.
 */
async function captureAndGrant(
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

/**
 * Poll/finalize endpoint for popup checkouts: reads the customer's latest
 * pending order intent and runs captureAndGrant on it.
 */
paypalReturnRouter.get("/poll", async (c) => {
	const customerId = c.req.query("customer_id") ?? "";
	if (!customerId) return c.json({ status: "none" });

	// Walk EVERY pending intent, newest first — a stuck one (e.g. sandbox
	// PAYER_ACTION_REQUIRED) must not block an APPROVED order behind it.
	const intents = await db
		.select()
		.from(paypalOrderIntents)
		.where(
			and(
				eq(paypalOrderIntents.customer_id, customerId),
				eq(paypalOrderIntents.status, "pending"),
			),
		)
		.orderBy(desc(paypalOrderIntents.id))
		.limit(5);

	if (intents.length === 0) return c.json({ status: "none" });

	let sawPending = false;
	let totalCaptured = 0;
	let captureCount = 0;
	for (const intent of intents) {
		const result = await captureAndGrant(intent.order_id, "poll_finalize");
		if (result.status === "captured") {
			totalCaptured += result.credits ?? 0;
			captureCount += 1;
			continue;
		}
		if (result.status === "pending") sawPending = true;
		// unapproved/error — skip and try the next intent
	}
	if (captureCount > 0) {
		return c.json({
			status: "captured",
			credits: totalCaptured,
			count: captureCount,
		});
	}
	return c.json({ status: sawPending ? "pending" : "none" });
});

/**
 * In-page Buttons capture: the host app calls this from the PayPal JS SDK's
 * onApprove with the order id.  Public — the order id is unguessable and the
 * grant is idempotent.
 */
paypalReturnRouter.post("/capture/:order_id", async (c) => {
	const orderId = c.req.param("order_id");
	const result = await captureAndGrant(orderId, "in_page_buttons");
	return c.json(result);
});
