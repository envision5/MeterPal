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
import { getSubscription } from "@/external/paypal/subscriptions.js";
import {
	activatePaypalSubscription,
	grantWalletCredits,
	resolveCustomer,
	stampPayerId,
} from "@/external/paypal/runPaypalWebhookHandlers.js";
import { captureAndGrant } from "./captureAndGrant.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";

export const paypalReturnRouter = new Hono<HonoEnv>();

// These routes are public by design (the buyer's browser and the host app's
// onApprove call them), so they get a coarse per-IP limiter: they proxy
// PayPal API calls and act on payment state, and an unthrottled version is
// both an enumeration oracle and a free PayPal-API amplification proxy.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

paypalReturnRouter.use("*", async (c, next) => {
	const ip =
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
		"x-unknown-ip";
	const now = Date.now();
	let bucket = rateBuckets.get(ip);
	if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
		bucket = { count: 0, windowStart: now };
		rateBuckets.set(ip, bucket);
		// bound the map — drop stale buckets once it grows past 10k entries
		if (rateBuckets.size > 10_000) {
			for (const [key, b] of rateBuckets) {
				if (now - b.windowStart >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key);
			}
		}
	}
	bucket.count += 1;
	if (bucket.count > RATE_LIMIT_MAX) {
		return c.json({ error: "rate_limited" }, 429);
	}
	await next();
});

/**
 * Browser-return handler — PayPal redirects the buyer's browser here after
 * they approve (orders AND subscriptions both point return_url at this
 * route).  This is what closes the standard (redirect) payment loop locally,
 * where no webhook tunnel exists:
 *   - orders:         capture + credit the wallet (idempotent on capture id,
 *                     the same key /paypal/poll, /paypal/capture and the
 *                     webhook use)
 *   - subscriptions:  activate the plan (idempotent on subscription id — the
 *                     BILLING.SUBSCRIPTION.* webhook lands here too when one
 *                     is configured)
 * then redirect the buyer back to the app.
 */
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

	// PayPal subscription ids are "I-" prefixed; order ids are not.
	if (token.startsWith("I-")) {
		try {
			const sub = await getSubscription(token);
			const activated = await activatePaypalSubscription(sub);
			if (activated) {
				logger.info({
					msg: "paypal return: subscription activated",
					token,
					status: sub?.status,
				});
				return c.redirect(`${appUrl}?payment=success`, 302);
			}
			logger.warn({
				msg: "paypal return: subscription not activatable",
				token,
				status: sub?.status,
			});
			return c.redirect(`${appUrl}?payment=error&reason=not_approved`, 302);
		} catch (err) {
			logger.error({
				msg: "paypal return: subscription handler failed",
				token,
				error: String(err),
			});
			return c.redirect(`${appUrl}?payment=error&reason=exception`, 302);
		}
	}

	// Subscriptions return with the BA- billing-agreement token, which is NOT
	// the subscription id.  Resolve the mapping recorded at checkout creation
	// (order_id = BA- token -> subscription_id = I- ...) and activate.
	if (token.startsWith("BA-")) {
		try {
			const [intent] = await db
				.select()
				.from(paypalOrderIntents)
				.where(eq(paypalOrderIntents.order_id, token))
				.limit(1);
			if (!intent?.subscription_id) {
				logger.warn({
					msg: "paypal return: no subscription mapping for BA token",
					token,
				});
				return c.redirect(`${appUrl}?payment=error&reason=no_mapping`, 302);
			}
			const sub = await getSubscription(intent.subscription_id);
			const activated = await activatePaypalSubscription(sub);
			if (activated) {
				logger.info({
					msg: "paypal return: subscription activated via BA mapping",
					token,
					subscriptionId: intent.subscription_id,
				});
				return c.redirect(`${appUrl}?payment=success&subscription=activated`, 302);
			}
			return c.redirect(`${appUrl}?payment=error&reason=not_approved`, 302);
		} catch (err) {
			logger.error({
				msg: "paypal return: BA subscription handler failed",
				token,
				error: String(err),
			});
			return c.redirect(`${appUrl}?payment=error&reason=exception`, 302);
		}
	}

	// One-off credit pack (Orders v2).  captureAndGrant is idempotent on the
	// capture id: a COMPLETED order replays cleanly (no second grant), and the
	// in-page/poll/webhook paths converge on the same key.
	try {
		const result = await captureAndGrant(token, "browser_return");
		if (result.status === "captured") {
			return c.redirect(
				`${appUrl}?payment=success&credits=${result.credits ?? ""}`,
				302,
			);
		}
		if (result.status === "pending" || result.status.startsWith("unapproved:")) {
			logger.warn({
				msg: "paypal return: order not approved",
				token,
				status: result.status,
			});
			return c.redirect(`${appUrl}?payment=error&reason=not_approved`, 302);
		}
		logger.error({
			msg: "paypal return: capture failed",
			token,
			reason: result.reason,
		});
		return c.redirect(`${appUrl}?payment=error&reason=capture`, 302);
	} catch (err) {
		logger.error({
			msg: "paypal return: handler failed",
			token,
			error: String(err),
		});
		return c.redirect(`${appUrl}?payment=error&reason=exception`, 302);
	}
});

/**
 * Poll/finalize endpoint for popup checkouts: reads the customer's latest
 * pending order intent — the order this checkout is actually paying for —
 * and runs captureAndGrant on it.
 *
 * Deliberately captures ONLY the newest pending intent.  Walking the whole
 * backlog would capture older approved-but-uncaptured orders too, charging
 * the buyer several times for one completed payment ("one payment, many
 * processed").  Older intents are abandoned by the checkout sweep; their
 * approvals are never charged.
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

	const result = await captureAndGrant(intent.order_id, "poll_finalize");
	if (result.status === "captured") {
		return c.json({ status: "captured", credits: result.credits ?? 0, count: 1 });
	}
	return c.json({ status: result.status === "pending" ? "pending" : "none" });
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

/**
 * Activation by subscription id — recovers subscriptions whose buyer
 * approved but whose activation failed (e.g. pre-mapping BA- returns).
 * Public but safe: activation requires PayPal to confirm the subscription
 * is ACTIVE, and every grant inside is idempotent.
 */
paypalReturnRouter.get("/activate/:subscriptionId", async (c) => {
	const subscriptionId = c.req.param("subscriptionId");
	try {
		const sub = await getSubscription(subscriptionId);
		const activated = await activatePaypalSubscription(sub);
		return c.json({
			subscriptionId,
			status: sub?.status,
			activated,
		});
	} catch (err) {
		return c.json(
			{ error: String(err).slice(0, 300) },
			500,
		);
	}
});
