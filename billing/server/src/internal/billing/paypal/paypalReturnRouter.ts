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
import { captureAndGrant } from "./captureAndGrant.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";

export const paypalReturnRouter = new Hono<HonoEnv>();

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
