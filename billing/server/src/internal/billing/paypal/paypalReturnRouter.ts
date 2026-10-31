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
import { paypalOrderIntents } from "@autumn/shared";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";

export const paypalReturnRouter = new Hono<HonoEnv>();

/**
 * Poll/finalize endpoint for popup checkouts.  The host app calls this while
 * the PayPal popup is open; when the buyer has approved (or the webhook
 * already captured), the order is captured server-side and the wallet is
 * credited — no browser redirect from PayPal required, which sandbox hermes
 * refuses to do for localhost return URLs.
 *
 * Response: { status: "captured" | "pending" | "none" | "error", credits? }
 */
paypalReturnRouter.get("/poll", async (c) => {
	const customerId = c.req.query("customer_id") ?? "";
	if (!customerId) return c.json({ status: "none" });

	const [intent] = await db
		.select()
		.from(paypalOrderIntents)
		.where(
			and(
				eq(paypalOrderIntents.customer_id, customerId),
				eq(paypalOrderIntents.status, "pending"),
			),
		)
		.orderBy(desc(paypalOrderIntents.id))
		.limit(1);

	if (!intent) return c.json({ status: "none" });

	try {
		const order = await paypalFetch<Record<string, any>>(
			`/v2/checkout/orders/${intent.order_id}`,
			{ method: "GET" },
		);

		let captureResource: Record<string, any> | undefined =
			order?.purchase_units?.[0]?.payments?.captures?.[0];

		if (order?.status === "APPROVED") {
			const capture = (await captureOrder(intent.order_id)) as Record<string, any>;
			captureResource = capture?.purchase_units?.[0]?.payments?.captures?.[0];
		}

		if (!captureResource || captureResource.status !== "COMPLETED") {
			return c.json({ status: "pending", order_status: order?.status });
		}

		const amount = parseFloat(captureResource.amount?.value ?? "0");
		const currency = (captureResource.amount?.currency_code ?? "USD").toUpperCase();
		const captureId = captureResource.id;
		if (!captureId || !amount || currency !== "USD") {
			logger.error({
				msg: "paypal poll: unsupported capture",
				orderId: intent.order_id,
				captureId,
				amount,
				currency,
			});
			return c.json({ status: "error", reason: "unsupported_capture" });
		}

		const [cust] = await db
			.select()
			.from(customers)
			.where(eq(customers.id, intent.customer_id))
			.limit(1);
		if (!cust?.id) {
			logger.error({
				msg: "paypal poll: customer not found",
				orderId: intent.order_id,
				customerId: intent.customer_id,
			});
			return c.json({ status: "error", reason: "no_customer" });
		}

		await grantWalletCredits({
			customer: cust,
			amountUsd: amount,
			idempotencyKey: `paypal-capture:${captureId}`,
			eventName: "wallet_topup",
			metadata: {
				capture_id: captureId,
				order_id: intent.order_id,
				via: "poll_finalize",
			},
		});

		await db
			.update(paypalOrderIntents)
			.set({ status: "captured" })
			.where(eq(paypalOrderIntents.id, intent.id));

		logger.info({
			msg: "paypal poll: captured and credited",
			orderId: intent.order_id,
			captureId,
			amount,
			customerId: cust.id,
		});
		return c.json({ status: "captured", credits: amount });
	} catch (err) {
		logger.error({
			msg: "paypal poll: failed",
			orderId: intent.order_id,
			error: String(err),
		});
		return c.json({ status: "error", reason: String(err).slice(0, 200) });
	}
});

paypalReturnRouter.get("/return", async (c) => {
	const appUrl =
		process.env.METERPAL_CHECKOUT_RETURN_URL ?? "http://localhost:5173";
	const token = c.req.query("token");

	if (c.req.query("cancelled")) {
		return c.redirect(`${appUrl}?payment=cancelled`, 302);
	}
	if (!token) {
		return c.redirect(`${appUrl}?payment=error&reason=missing_token`, 302);
	}

	try {
		const order = await paypalFetch<Record<string, any>>(
			`/v2/checkout/orders/${token}`,
			{ method: "GET" },
		);

		if (order.status === "COMPLETED") {
			// Already captured (retry or the webhook beat us) — land cleanly.
			return c.redirect(`${appUrl}?payment=success`, 302);
		}
		if (order.status !== "APPROVED") {
			logger.warn({ msg: "paypal return: order not approved", token, status: order.status });
			return c.redirect(`${appUrl}?payment=error&reason=not_approved`, 302);
		}

		const customId: string | undefined =
			order.purchase_units?.[0]?.custom_id;
		const capture = (await captureOrder(token)) as Record<string, any>;
		const captureResource =
			capture?.purchase_units?.[0]?.payments?.captures?.[0];
		const captureId = captureResource?.id;
		const amount = parseFloat(captureResource?.amount?.value ?? "0");
		const currency = (captureResource?.amount?.currency_code ?? "USD").toUpperCase();
		if (!captureId || !amount || currency !== "USD") {
			logger.error({ msg: "paypal return: capture missing amount", token, captureId, amount, currency });
			return c.redirect(`${appUrl}?payment=error&reason=capture`, 302);
		}

		let customCustomerId: string | undefined;
		if (customId?.startsWith("mp:")) {
			customCustomerId = customId.split(":")[1];
		}
		const payerId = capture?.payer?.payer_id ?? order.payer?.payer_id ?? null;

		const cust = await resolveCustomer({
			customId: customCustomerId,
			payerId,
			email: capture?.payer?.email_address ?? null,
		});
		if (!cust?.id) {
			logger.error({ msg: "paypal return: no customer for order", token, customId });
			return c.redirect(`${appUrl}?payment=error&reason=no_customer`, 302);
		}

		await stampPayerId(cust.id, payerId);
		await grantWalletCredits({
			customer: cust,
			amountUsd: amount,
			idempotencyKey: `paypal-capture:${captureId}`,
			eventName: "wallet_topup",
			metadata: {
				capture_id: captureId,
				order_id: token,
				via: "browser_return",
			},
		});

		logger.info({
			msg: "paypal return: captured and credited",
			token,
			captureId,
			amount,
			customerId: cust.id,
		});
		return c.redirect(
			`${appUrl}?payment=success&credits=${amount}`,
			302,
		);
	} catch (err) {
		logger.error({ msg: "paypal return: handler failed", token, error: String(err) });
		return c.redirect(`${appUrl}?payment=error&reason=exception`, 302);
	}
});
