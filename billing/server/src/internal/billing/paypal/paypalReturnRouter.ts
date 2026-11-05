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

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { paypalOrderIntents, type AppEnv } from "@autumn/shared";
import { db } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import type { PaypalClient } from "@/external/paypal/paypalClient.js";
import { getSubscription } from "@/external/paypal/subscriptions.js";
import { isLivePaypalSubscription } from "@/internal/billing/paypal/decideSubscriptionAction.js";
import { activatePaypalSubscription } from "@/external/paypal/runPaypalWebhookHandlers.js";
import { captureAndGrant } from "./captureAndGrant.js";
import {
	getPaypalClientForOrder,
	getPaypalClientForOrg,
	getPaypalContextForSubscription,
} from "./paypalOrgClient.js";
import { getTrustedClientIp } from "@/internal/misc/rateLimiter/public/getTrustedClientIp.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";

export const paypalReturnRouter = new Hono<HonoEnv>();

// These routes are public by design (the buyer's browser and the host app's
// onApprove call them), so they get a coarse limiter: they proxy PayPal API
// calls and act on payment state, and an unthrottled version is both an
// enumeration oracle and a free PayPal-API amplification proxy.
//
// Two buckets per request:
//   - per CLIENT IP — the peer address from the socket when available
//     (never client-spoofable); XFF is only consulted through the
//     TRUSTED_PROXY_DEPTH-aware helper, never taken at face value.  The
//     old first-XFF-entry key let an attacker rotate the header per
//     request and render the limiter decorative.
//   - per ROUTE ARGUMENT (customer_id / order id / subscription id) — so
//     enumerating many ids from one address is bounded on both axes.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_MAX_PER_ARG = 30;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

const hitBucket = (key: string, max: number): boolean => {
	const now = Date.now();
	let bucket = rateBuckets.get(key);
	if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
		bucket = { count: 0, windowStart: now };
		rateBuckets.set(key, bucket);
		// bound the map — drop stale buckets once it grows past 10k entries
		if (rateBuckets.size > 10_000) {
			for (const [k, b] of rateBuckets) {
				if (now - b.windowStart >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k);
			}
		}
	}
	bucket.count += 1;
	return bucket.count > max;
};

/** The client's real peer address, falling back to proxy-aware headers. */
const clientIp = (c: Context<HonoEnv>): string => {
	try {
		const incoming = (
			c.env as unknown as {
				incoming?: { socket?: { remoteAddress?: string } };
			}
		)?.incoming;
		const peer = incoming?.socket?.remoteAddress;
		if (peer) return peer;
	} catch {
		// fall through to header-based resolution
	}
	return getTrustedClientIp({ c });
};

paypalReturnRouter.use("*", async (c, next) => {
	const ip = clientIp(c);
	if (hitBucket(`ip:${ip}`, RATE_LIMIT_MAX)) {
		return c.json({ error: "rate_limited" }, 429);
	}
	// Per-argument buckets: the poller names a customer, capture/activate
	// name an order or subscription.  Rotating either no longer buys
	// unlimited probes.
	const customerId = c.req.query("customer_id");
	if (customerId && hitBucket(`cus:${customerId}`, RATE_LIMIT_MAX_PER_ARG)) {
		return c.json({ error: "rate_limited" }, 429);
	}
	const argId =
		c.req.param("order_id") ?? c.req.param("subscriptionId") ?? undefined;
	if (argId && hitBucket(`arg:${argId}`, RATE_LIMIT_MAX_PER_ARG)) {
		return c.json({ error: "rate_limited" }, 429);
	}
	await next();
});

type SubscriptionLookup = {
	subscriptionId: string;
	client: PaypalClient;
	orgId: string;
} | null;

/**
 * Resolves a key the buyer's redirect can carry back to the subscription it
 * belongs to.
 *
 * Two keys are recorded per checkout:
 *   - the BA- billing-agreement token from the approval link, and
 *   - a checkout token WE mint and put in the return URL.
 *
 * Both are looked up in `paypal_order_intents` (order_id -> subscription_id).
 * The intent row also names the org, so the subscription is read through that
 * org's PayPal account — not through whichever account happens to be
 * configured process-wide.
 */
async function findSubscriptionForKey(key: string): Promise<SubscriptionLookup> {
	if (!key) return null;
	const [intent] = await db
		.select({
			subscription_id: paypalOrderIntents.subscription_id,
			org_id: paypalOrderIntents.org_id,
			env: paypalOrderIntents.env,
		})
		.from(paypalOrderIntents)
		.where(eq(paypalOrderIntents.order_id, key))
		.limit(1);
	if (!intent?.subscription_id) return null;
	const client = await getPaypalClientForOrg(
		intent.org_id,
		intent.env as AppEnv,
	);
	if (!client) return null;
	return {
		subscriptionId: intent.subscription_id,
		client,
		// Scopes the customer fallbacks on activation to THIS org.
		orgId: intent.org_id,
	};
}

/**
 * Fallback resolution for a redirect token we have never seen.
 *
 * PayPal does NOT redirect a subscription approval with the BA- token from the
 * approval link — it redirects with the express-checkout token of the order it
 * created for that approval (e.g. "8BU33449JX813240W").  That order names the
 * payer, and the payer names the subscription: find the customer whose pending
 * subscription PayPal now reports as ACTIVE for the same payer id.
 */
async function findApprovedSubscriptionByPayer(
	orderToken: string,
): Promise<SubscriptionLookup> {
	// The order was created for one org; only that org's PayPal account is
	// asked about it.
	const client = await getPaypalClientForOrder(orderToken);
	if (!client) return null;

	let payerId: string | undefined;
	try {
		const order = await client.fetch<{ payer?: { payer_id?: string } }>(
			`/v2/checkout/orders/${orderToken}`,
			{ method: "GET" },
		);
		payerId = order?.payer?.payer_id;
	} catch {
		return null;
	}
	if (!payerId) return null;

	// Only this org's subscriptions that are still awaiting approval can
	// match.
	const pendings = await db
		.select({
			subscription_id: paypalOrderIntents.subscription_id,
			org_id: paypalOrderIntents.org_id,
		})
		.from(paypalOrderIntents)
		.where(
			and(
				eq(paypalOrderIntents.status, "pending"),
				isNotNull(paypalOrderIntents.subscription_id),
			),
		);

	for (const row of pendings) {
		if (!row.subscription_id) continue;
		try {
			const sub = await getSubscription(client, row.subscription_id);
			if (
				sub?.subscriber?.payer_id === payerId &&
				isLivePaypalSubscription(sub.status)
			) {
				return { subscriptionId: sub.id, client, orgId: row.org_id };
			}
		} catch {
			// subscription gone at PayPal — try the next pending one
		}
	}
	return null;
}

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
	const checkout = c.req.query("checkout");

	if (c.req.query("cancelled")) {
		return c.redirect(`${appUrl}?payment=cancelled`, 302);
	}
	if (!token && !checkout) {
		return c.redirect(`${appUrl}?payment=error&reason=missing_token`, 302);
	}

	logger.info({
		msg: "paypal return: buyer came back",
		// Payment tokens are credentials — log a prefix only, never the value.
		token: token?.slice(0, 8),
		checkout: checkout?.slice(0, 8),
	});

	// Subscriptions: resolve the key back to the subscription id.  The
	// checkout token (our own, in the return URL) is authoritative; the BA-
	// token from the approval link is the fallback for links created before
	// the checkout token existed.
	const lookup =
		(await findSubscriptionForKey(checkout ?? "")) ??
		(await findSubscriptionForKey(token ?? ""));

	if (lookup) {
		const { subscriptionId, client, orgId } = lookup;
		try {
			const sub = await getSubscription(client, subscriptionId);
			const activated = await activatePaypalSubscription(sub, orgId);
			if (activated) {
				logger.info({
					msg: "paypal return: subscription activated",
					token: token?.slice(0, 8),
					checkout: checkout?.slice(0, 8),
					subscriptionId,
					status: sub?.status,
				});
				return c.redirect(`${appUrl}?payment=success&subscription=activated`, 302);
			}
			logger.warn({
				msg: "paypal return: subscription not activatable",
				token: token?.slice(0, 8),
				checkout: checkout?.slice(0, 8),
				subscriptionId,
				status: sub?.status,
			});
			return c.redirect(`${appUrl}?payment=error&reason=not_approved`, 302);
		} catch (err) {
			logger.error({
				msg: "paypal return: subscription handler failed",
				token: token?.slice(0, 8),
				checkout: checkout?.slice(0, 8),
				error: String(err),
			});
			return c.redirect(`${appUrl}?payment=error&reason=exception`, 302);
		}
	}

	// PayPal redirects a subscription approval with the express-checkout token
	// of the order it created for that approval, not with the BA- token.  Find
	// the subscription that approval belongs to through the payer.
	if (token) {
		const approved = await findApprovedSubscriptionByPayer(token);
		if (approved) {
			const { subscriptionId: approvedId, client, orgId } = approved;
			try {
				const sub = await getSubscription(client, approvedId);
				const activated = await activatePaypalSubscription(sub, orgId);
				if (activated) {
					logger.info({
						msg: "paypal return: subscription activated via payer match",
						token: token?.slice(0, 8),
						subscriptionId: approvedId,
						status: sub?.status,
					});
					return c.redirect(
						`${appUrl}?payment=success&subscription=activated`,
						302,
					);
				}
			} catch (err) {
				logger.error({
					msg: "paypal return: payer-matched subscription failed",
					token: token?.slice(0, 8),
					subscriptionId: approvedId,
					error: String(err),
				});
			}
		}
	}

	// PayPal subscription ids are "I-" prefixed; order ids are not.
	if (token?.startsWith("I-")) {
		try {
			const context = await getPaypalContextForSubscription(token);
			if (!context) {
				return c.redirect(`${appUrl}?payment=error&reason=no_org`, 302);
			}
			const { client, orgId } = context;
			const sub = await getSubscription(client, token);
			const activated = await activatePaypalSubscription(sub, orgId);
			if (activated) {
				logger.info({
					msg: "paypal return: subscription activated",
					token: token.slice(0, 8),
					status: sub?.status,
				});
				return c.redirect(`${appUrl}?payment=success`, 302);
			}
			logger.warn({
				msg: "paypal return: subscription not activatable",
				token: token.slice(0, 8),
				status: sub?.status,
			});
			return c.redirect(`${appUrl}?payment=error&reason=not_approved`, 302);
		} catch (err) {
			logger.error({
				msg: "paypal return: subscription handler failed",
				token: token.slice(0, 8),
				error: String(err),
			});
			return c.redirect(`${appUrl}?payment=error&reason=exception`, 302);
		}
	}

	// One-off credit pack (Orders v2).  captureAndGrant is idempotent on the
	// capture id: a COMPLETED order replays cleanly (no second grant), and the
	// in-page/poll/webhook paths converge on the same key.
	try {
		const result = await captureAndGrant(token!, "browser_return");
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
		const context = await getPaypalContextForSubscription(subscriptionId);
		if (!context) {
			return c.json({ error: "unknown subscription" }, 404);
		}
		const { client, orgId } = context;
		const sub = await getSubscription(client, subscriptionId);
		// The org scopes the customer fallbacks inside activation.
		const activated = await activatePaypalSubscription(sub, orgId);
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
