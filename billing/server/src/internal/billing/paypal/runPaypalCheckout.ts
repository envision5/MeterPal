// billing/server/src/internal/billing/paypal/runPaypalCheckout.ts
//
// The PayPal branch of the checkout flow.  Mirrors the Stripe path in
// `../checkout/runCheckout.ts`: given the same AttachParams, it returns a
// `checkout_url` — either a PayPal Orders v2 approval link (one-off credit
// packs) or a PayPal Subscriptions approval link (recurring plans) — so every
// caller (SDK, UI components, API) works against PayPal unchanged.
//
// Customer/product linkage travels in the PayPal custom_id:
//   orders:  "mp:<customer_id>:<product_id>"
//   subs:    custom_id = "<customer_id>"
// Webhook handlers (external/paypal/runPaypalWebhookHandlers.ts) read these to
// grant credits to the right customer without relying on emails.

import type { AppEnv } from "@autumn/shared";
import {
	BillingInterval,
	customers,
	type FullProduct,
	type Organization,
	type Price,
	PriceType,
	paypalCatalogMap,
	paypalOrderIntents,
	RecaseError,
} from "@autumn/shared";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import { createOrder, type OrderResponse } from "@/external/paypal/orders.js";
import {
	getPaypalClient,
	type PaypalClient,
} from "@/external/paypal/paypalClient.js";
import { activatePaypalSubscription } from "@/external/paypal/runPaypalWebhookHandlers.js";
import {
	approvalLink,
	approvalTokenFromUrl,
	cancelSubscription,
	createBillingPlan,
	createCatalogProduct,
	createSubscription,
	getSubscription,
	intervalToPaypalUnit,
	type PayPalSubscription,
	reviseSubscription,
} from "@/external/paypal/subscriptions.js";
import {
	decidePaypalSubscriptionAction,
	isLivePaypalSubscription,
} from "@/internal/billing/paypal/decideSubscriptionAction.js";
import {
	decidePaypalPlanResync,
	syncPaypalCatalogForProduct,
} from "@/internal/billing/paypal/paypalCatalogSync.js";
import type { AttachParams } from "@/internal/customers/cusProducts/AttachParams.js";

/**
 * USD amount for a price, major units.  Handles both stored shapes:
 *   fixed:      { type: "fixed", amount }
 *   usage/prepaid credit packs: { type: "usage", usage_tiers: [{to: "inf", amount}] }
 */
export function priceAmountUsd(price: Price): number | null {
	const cfg = price.config as {
		type?: string;
		amount?: number;
		usage_tiers?: Array<{ to?: string | number | null; amount?: number }>;
	};
	if (cfg.type === PriceType.Fixed) return cfg.amount ?? null;
	const inf = (cfg.usage_tiers ?? []).find(
		(t) => t.to === "inf" || t.to === null || t.to === undefined,
	);
	return inf?.amount ?? null;
}

/**
 * The recurring amount a PayPal subscription for this product charges per
 * cycle (0 when the product has no fixed recurring price).
 */
function subAmountUsd(product: FullProduct): number {
	const subPrice = recurringFixedPrice(product);
	return subPrice ? (priceAmountUsd(subPrice) ?? 0) : 0;
}

/**
 * Records the mapping from every key the buyer's redirect can carry back to
 * the subscription id (I-...) it approves.
 *
 * Two keys are recorded per checkout:
 *   - the BA- billing-agreement token from the approval link, and
 *   - a checkout token WE mint and put in the return URL.
 *
 * The browser return route resolves the subscription through this mapping.
 * Without it the buyer comes back from PayPal and the activation cannot be
 * matched ("no_mapping") — the customer paid and nothing happened.
 */
async function recordApprovalIntent({
	db,
	url,
	subscriptionId,
	orgId,
	env,
	customerId,
	productId,
	amountUsd,
	extraTokens = [],
}: {
	db: DrizzleCli;
	url: string;
	subscriptionId: string;
	orgId: string;
	env: AppEnv;
	customerId: string;
	productId: string;
	amountUsd: number;
	extraTokens?: string[];
}): Promise<void> {
	// PayPal puts the token in `ba_token` on a subscription approval link (an
	// order link uses `token`).  Reading only `token` wrote an EMPTY order_id.
	const tokens = new Set<string>();
	const baToken = approvalTokenFromUrl(url);
	if (baToken) tokens.add(baToken);
	for (const token of extraTokens) {
		if (token) tokens.add(token);
	}

	if (tokens.size === 0) {
		logger.warn({
			msg: "paypal checkout: approval link carried no billing-agreement token",
			subscriptionId,
			customerId,
		});
		return;
	}

	for (const token of tokens) {
		await db
			.insert(paypalOrderIntents)
			.values({
				order_id: token,
				subscription_id: subscriptionId,
				org_id: orgId,
				env,
				customer_id: customerId,
				product_id: productId,
				amount_usd: amountUsd,
				status: "pending",
			})
			.onConflictDoNothing();
	}
}

export { approvalTokenFromUrl };

/** True when every price on the attach is a one-off charge (credit packs). */
export function pricesAreOneOff(prices: Price[]): boolean {
	return (
		prices.length > 0 &&
		prices.every(
			(p) =>
				(p.config as { interval?: BillingInterval }).interval ===
				BillingInterval.OneOff,
		)
	);
}

/** First recurring price on the product — the PayPal plan amount. */
export function recurringFixedPrice(product: FullProduct): Price | null {
	return (
		product.prices.find(
			(p) =>
				(p.config as { interval?: BillingInterval }).interval !==
					BillingInterval.OneOff && priceAmountUsd(p) != null,
		) ?? null
	);
}

function toUsd(amount: number): string {
	return new Intl.NumberFormat("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(amount);
}

/**
 * PayPal redirects the buyer's browser here after approval/cancel.  The
 * server-side return route captures the order and credits the wallet —
 * this closes the loop locally without a public webhook URL.
 *
 * `checkoutToken` is a key WE mint for this checkout attempt.  It travels in
 * the return URL so the buyer's redirect carries something we can resolve
 * back to the subscription: PayPal does NOT redirect a subscription approval
 * with the BA- token from the approval link, it redirects with the
 * express-checkout token of the order it created for that approval.
 */
function paypalRedirectUrls(checkoutToken?: string): {
	returnUrl: string;
	cancelUrl: string;
} {
	const base = process.env.METERPAL_PUBLIC_URL ?? "http://localhost:8080";
	const query = checkoutToken
		? `?checkout=${encodeURIComponent(checkoutToken)}`
		: "";
	return {
		returnUrl: `${base}/paypal/return${query}`,
		cancelUrl: `${base}/paypal/return${query}${query ? "&" : "?"}cancelled=1`,
	};
}

/** A key we mint for one checkout attempt, so the redirect resolves to it. */
function newCheckoutToken(): string {
	return `mp-checkout-${crypto.randomUUID()}`;
}

/**
 * PayPal product id for a plan.  PayPal's model is one catalog product per
 * service with many billing plans underneath — so a shared product id via
 * `PAYPAL_PRODUCT_ID` is the preferred setup.  Otherwise one product is
 * auto-created per MeterPal plan through /v1/catalog/products (some sandbox
 * accounts return 404 on that endpoint — set PAYPAL_PRODUCT_ID there).
 */
async function resolvePaypalProductId({
	client,
	org,
	env,
	product,
	existingProductId,
}: {
	client: PaypalClient;
	org: Organization;
	env: AppEnv;
	product: FullProduct;
	existingProductId: string | null;
}): Promise<string> {
	if (existingProductId) return existingProductId;

	const shared = process.env.PAYPAL_PRODUCT_ID;
	if (shared) return shared;

	try {
		const created = await createCatalogProduct({
			client,
			name: `${org.slug ?? org.id} — ${product.name}`.slice(0, 127),
			description: `MeterPal plan ${product.id} (${org.slug ?? org.id})`.slice(
				0,
				127,
			),
			sku: `${org.id}:${env}:${product.id}`.slice(0, 127),
			idempotencyKey: `mp-catprod-${org.id}-${env}-${product.id}`,
		});
		return created.id;
	} catch (err) {
		// Some PayPal sandbox accounts hard-404 the whole catalog API (empty
		// body on POST and GET).  Plans need a product id, so subscriptions are
		// blocked until one exists — fail with the fix, not a raw 500.
		const msg = String(err);
		if (msg.includes("/v1/catalog/products 404")) {
			throw new RecaseError({
				message:
					"PayPal catalog API is unavailable for this app (404). " +
					"Create a product in the PayPal business dashboard (Pay & Get Paid → Subscriptions), " +
					"then set PAYPAL_PRODUCT_ID=<product id> in billing/server/.env and restart the billing server.",
				statusCode: 502,
			});
		}
		throw err;
	}
}

/**
 * Get-or-create the PayPal catalog product + billing plan for an Autumn
 * product, cached in `paypal_catalog_map`.  Shared by the checkout path and
 * the catalog sync script (server/scripts/paypalCatalog.ts).
 */
export async function ensurePaypalPlan({
	client,
	db,
	org,
	env,
	product,
}: {
	client: PaypalClient;
	db: DrizzleCli;
	org: Organization;
	env: AppEnv;
	product: FullProduct;
}): Promise<string> {
	const [existing] = await db
		.select()
		.from(paypalCatalogMap)
		.where(
			and(
				eq(paypalCatalogMap.org_id, org.id),
				eq(paypalCatalogMap.env, env),
				eq(paypalCatalogMap.product_id, product.id),
			),
		)
		.limit(1);
	if (existing?.paypal_plan_id) {
		// The mapped PayPal plan must never charge a stale price: if the
		// product's recurring price drifted from the mapping (an edit-time
		// sync failed, or the plan was versioned), re-sync before the buyer is
		// redirected.  In-sync products skip the PayPal call entirely.
		const decision = decidePaypalPlanResync({ mapRow: existing, product });
		if (decision.action !== "in_sync") {
			try {
				await syncPaypalCatalogForProduct({ db, org, env, product });
				const [updated] = await db
					.select()
					.from(paypalCatalogMap)
					.where(
						and(
							eq(paypalCatalogMap.org_id, org.id),
							eq(paypalCatalogMap.env, env),
							eq(paypalCatalogMap.product_id, product.id),
						),
					)
					.limit(1);
				if (updated?.paypal_plan_id) return updated.paypal_plan_id;
			} catch (err) {
				// Fall through to the mapped plan rather than failing checkout —
				// the edit-time sync will surface the problem to the merchant.
				logger.warn({
					msg: "paypal checkout: plan re-sync failed, using the mapped plan",
					productId: product.id,
					error: String(err),
				});
			}
		}
		return existing.paypal_plan_id;
	}

	const price = recurringFixedPrice(product);
	if (!price) {
		throw new RecaseError({
			message: `Product ${product.id} has no fixed recurring price to map to a PayPal plan`,
			statusCode: 400,
		});
	}
	const config = price.config as {
		amount?: number;
		interval: BillingInterval;
		interval_count?: number;
		usage_tiers?: Array<{ to?: string | number | null; amount?: number }>;
	};
	const planAmount = priceAmountUsd(price);
	if (planAmount == null) {
		throw new RecaseError({
			message: `Product ${product.id}: cannot resolve a USD amount for the PayPal plan`,
			statusCode: 400,
		});
	}

	const paypalProductId = await resolvePaypalProductId({
		client,
		org,
		env,
		product,
		existingProductId: existing?.paypal_product_id ?? null,
	});

	const plan = await createBillingPlan({
		client,
		productId: paypalProductId,
		name: product.name.slice(0, 127),
		description: `MeterPal plan ${product.id}`.slice(0, 127),
		intervalUnit: intervalToPaypalUnit(config.interval),
		intervalCount: config.interval_count ?? 1,
		amountUsd: planAmount,
		idempotencyKey: `mp-plan-${org.id}-${env}-${product.id}`,
	});

	const row = {
		org_id: org.id,
		env,
		product_id: product.id,
		paypal_product_id: paypalProductId,
		paypal_plan_id: plan.id,
		name: product.name,
		interval: config.interval,
		amount_usd: planAmount,
	};
	await db
		.insert(paypalCatalogMap)
		.values(row)
		.onConflictDoUpdate({
			target: [
				paypalCatalogMap.org_id,
				paypalCatalogMap.env,
				paypalCatalogMap.product_id,
			],
			set: {
				paypal_product_id: row.paypal_product_id,
				paypal_plan_id: row.paypal_plan_id,
				amount_usd: row.amount_usd,
				interval: row.interval,
				name: row.name,
			},
		});

	return plan.id;
}

/**
 * Cancels every other live order intent for this customer at PayPal and
 * marks them abandoned.  Guarantees at most ONE live order per customer:
 * stale orders can never be approved later (which would charge the buyer
 * for a checkout they've abandoned) and never block the poll.
 *
 * NEVER captures here.  An approved-but-uncaptured order has moved no
 * money — capturing it during a later checkout would charge the buyer for
 * a payment they never saw complete ("one payment, many processed").
 * Captures only happen in the flow that owns the order: /paypal/return,
 * the in-page onApprove capture, and /paypal/poll for the current order.
 * Uncapturable approvals simply expire at PayPal.
 */
async function abandonOtherIntents({
	client,
	db,
	customerId,
	exceptOrderId,
}: {
	client: PaypalClient;
	db: DrizzleCli;
	customerId: string;
	exceptOrderId?: string;
}): Promise<void> {
	const pendings = await db
		.select()
		.from(paypalOrderIntents)
		.where(
			and(
				eq(paypalOrderIntents.customer_id, customerId),
				eq(paypalOrderIntents.status, "pending"),
			),
		);
	for (const intent of pendings) {
		if (intent.order_id === exceptOrderId) continue;
		// Subscription approvals are not Orders v2 — cancelling them here would
		// 404 at PayPal and would throw away the mapping the buyer's return
		// needs to resolve.  The subscription flow manages its own intents.
		if (intent.subscription_id) continue;
		try {
			// Only CREATED orders are cancellable at PayPal; best-effort either
			// way — APPROVED-but-uncaptured ones are left to expire, charging
			// nobody.
			await client.fetch(`/v2/checkout/orders/${intent.order_id}/cancel`, {
				method: "POST",
				body: "{}",
			});
		} catch {
			// already processed / not cancellable — still stop tracking it
		}
		await db
			.update(paypalOrderIntents)
			.set({ status: "abandoned" })
			.where(eq(paypalOrderIntents.id, intent.id));
		logger.info({
			msg: "paypal checkout: abandoned stale order",
			orderId: intent.order_id,
			customerId,
		});
	}
}

/**
 * PayPal checkout: returns the buyer-approval URL, same contract as the
 * Stripe path's `checkout_url`.
 */
export async function runPaypalCheckout({
	attachParams,
	db,
	env,
}: {
	attachParams: Pick<
		AttachParams,
		"org" | "customer" | "products" | "prices" | "successUrl"
	>;
	db: DrizzleCli;
	env: AppEnv;
}): Promise<string | null> {
	const { org, customer, products, prices, successUrl } = attachParams;
	const client = await getPaypalClient({ org, env });

	if (!customer.id) {
		throw new RecaseError({
			message: "PayPal checkout requires a customer id",
			statusCode: 400,
		});
	}
	const customerId = customer.id;

	if (products.length !== 1) {
		throw new RecaseError({
			message: "PayPal checkout supports exactly one product per call",
			statusCode: 400,
		});
	}
	const product = products[0];

	void successUrl; // the server return route owns the landing experience

	if (pricesAreOneOff(prices)) {
		// One-off credit pack -> Orders v2.
		// ORDER REUSE: every pack click must NOT mint a new PayPal order —
		// each approval is a real buyer charge.  Reuse the customer's latest
		// pending order if PayPal still has it in CREATED (approvable) state;
		// APPROVED ones are captured by the poll/capture endpoints.
		const [pendingIntent] = await db
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
		if (pendingIntent) {
			// Sandbox orders are BORN in PAYER_ACTION_REQUIRED (payer must
			// verify their card) — that state is still approvable, so reuse it.
			// Freshness window: a permanently-stuck order must not lock the
			// buyer out of ever buying again.
			const freshUntil =
				new Date(pendingIntent.created_at).getTime() + 30 * 60 * 1000;
			const isFresh = Date.now() < freshUntil;
			try {
				const existing = await client.fetch<Record<string, any>>(
					`/v2/checkout/orders/${pendingIntent.order_id}`,
					{ method: "GET" },
				);
				const reusable = ["CREATED", "PAYER_ACTION_REQUIRED"].includes(
					existing?.status,
				);
				if (isFresh && reusable) {
					const url = approvalLink(existing.links);
					if (url) {
						logger.info({
							msg: "paypal checkout: reusing pending order",
							orderId: pendingIntent.order_id,
							customerId,
						});
						// Keep the one-live-order invariant: honor any approvals
						// in older intents, cancel + abandon the rest.
						await abandonOtherIntents({
							client,
							db,
							customerId,
							exceptOrderId: pendingIntent.order_id,
						});
						return url;
					}
				}
				// APPROVED -> the poll/capture endpoints will grab it.
				// Anything else (expired/voided/stale) -> mint fresh.
			} catch {
				// order lookup failed (e.g. voided) — mint fresh
			}
		}

		const amounts = prices.map((p) => priceAmountUsd(p) ?? 0);
		const total = amounts.reduce((sum, a) => sum + a, 0);
		if (total <= 0) {
			throw new RecaseError({
				message: "PayPal order total must be positive",
				statusCode: 400,
			});
		}

		// At most one live order per customer: cancel + abandon every other
		// pending intent before minting a fresh one.
		await abandonOtherIntents({ client, db, customerId });

		// Record the intent so the finalize/poll endpoint can capture the
		// order without depending on PayPal's browser redirect.
		const order = await createOrder(
			client,
			{
				intent: "CAPTURE",
				purchase_units: [
					{
						reference_id: product.id,
						custom_id: `mp:${customerId}:${product.id}`,
						description: product.name.slice(0, 127),
						amount: {
							currency_code: "USD",
							value: toUsd(total),
							breakdown: {
								item_total: { currency_code: "USD", value: toUsd(total) },
							},
						},
						items: amounts.map((amount) => ({
							name: `${product.name}`.slice(0, 127),
							quantity: "1",
							unit_amount: {
								currency_code: "USD",
								value: toUsd(amount),
							},
							category: "DIGITAL_GOODS" as const,
						})),
					},
				],
				payment_source: {
					paypal: {
						experience_context: {
							shipping_preference: "NO_SHIPPING",
							user_action: "PAY_NOW",
							brand_name: (org.name ?? "MeterPal").slice(0, 127),
						},
					},
				},
			},
			{ idempotencyKey: `mp-order-${crypto.randomUUID()}` },
		);

		await db.insert(paypalOrderIntents).values({
			order_id: order.id,
			org_id: org.id,
			env,
			customer_id: customerId,
			product_id: product.id,
			amount_usd: total,
			status: "pending",
		});

		const url = approvalLink(order.links);
		if (!url) {
			throw new RecaseError({
				message: "PayPal order returned no approval link",
				statusCode: 500,
			});
		}
		return url;
	}

	// Recurring plan -> PayPal subscription.
	//
	// SUBSCRIPTION REUSE: every plan click must NOT mint a new PayPal
	// subscription — each buyer approval is an immediate real charge.  Track
	// the customer's latest subscription on the customer row and:
	//   APPROVED/ACTIVE -> the buyer already paid; activate it, never re-mint
	//   APPROVAL_PENDING (same plan, fresh) -> reuse its approval link
	//   APPROVAL_PENDING (stale)         -> cancel it at PayPal, mint fresh
	const [cusRow] = await db
		.select({
			internal_id: customers.internal_id,
			paypal_subscription_id: customers.paypal_subscription_id,
			paypal_plan_id: customers.paypal_plan_id,
			paypal_payment_status: customers.paypal_payment_status,
		})
		.from(customers)
		.where(eq(customers.internal_id, customer.internal_id))
		.limit(1);

	// PayPal is the source of truth for the subscription.  The customer row
	// only remembers WHICH subscription we last started — it goes stale (the
	// buyer cancels or the subscription expires on PayPal) and trusting it
	// would hand out a paid plan for free, or skip a purchase that is still
	// owed.  So ask PayPal before deciding anything.
	let existing: PayPalSubscription | null = null;
	if (cusRow?.paypal_subscription_id) {
		try {
			existing = await getSubscription(client, cusRow.paypal_subscription_id);
		} catch {
			// Subscription is gone at PayPal (deleted / never created) — fall
			// through and mint a fresh one.
			existing = null;
		}
	}

	const paypalStatus = existing?.status ?? "";
	const isLive = isLivePaypalSubscription(paypalStatus);
	const createTime = existing?.create_time
		? new Date(existing.create_time).getTime()
		: 0;
	const approvalUrl = approvalLink(existing?.links);

	// A plan with NO recurring price is FREE: there is nothing to buy at
	// PayPal, so no subscription is created and no approval link exists.
	// Switching to a free plan is a DOWNGRADE — it ends the paid PayPal
	// subscription the customer is on.  Returning "no checkout URL" lets the
	// caller apply the free plan directly: no redirect, no charge.
	if (!recurringFixedPrice(product)) {
		if (existing) {
			try {
				await cancelSubscription(
					client,
					existing.id,
					"Switched to a free MeterPal plan",
				);
				logger.info({
					msg: "paypal checkout: cancelled the paid subscription for a free-plan switch",
					subscriptionId: existing.id,
					status: paypalStatus,
					customerId,
				});
			} catch (err) {
				if (isLive) {
					// The buyer is still being billed for the paid plan.  Applying
					// the free plan now would keep charging them for a plan they
					// left — fail loudly instead of half-applying the downgrade.
					logger.error({
						msg: "paypal checkout: could not cancel the paid subscription for a free-plan switch",
						subscriptionId: existing.id,
						customerId,
						error: String(err),
					});
					throw new RecaseError({
						message:
							"Could not cancel the PayPal subscription for the plan change",
						statusCode: 502,
					});
				}
				// An unapproved subscription cannot be cancelled at PayPal (404) —
				// nothing is being billed, so best effort is enough.
				logger.warn({
					msg: "paypal checkout: could not cancel the pending subscription for a free-plan switch",
					subscriptionId: existing.id,
					customerId,
					error: String(err),
				});
			}
			// Stop tracking it either way: a stale subscription id would make the
			// next upgrade reuse an approval link for a cancelled plan.
			await db
				.update(customers)
				.set({
					paypal_subscription_id: null,
					paypal_plan_id: null,
					paypal_payment_status: "cancelled",
				})
				.where(eq(customers.internal_id, customer.internal_id));
		}
		return null;
	}

	const planId = await ensurePaypalPlan({ client, db, org, env, product });

	// A key WE mint for this checkout attempt.  It travels in the return URL
	// so the buyer's redirect carries something we can resolve back to the
	// subscription: PayPal redirects a subscription approval with the
	// express-checkout token of the order it created for that approval, NOT
	// with the BA- token from the approval link.
	const checkoutToken = newCheckoutToken();
	const { returnUrl, cancelUrl } = paypalRedirectUrls(checkoutToken);

	const action = decidePaypalSubscriptionAction({
		paypalStatus,
		subscriptionPlanId: existing?.plan_id,
		targetPlanId: planId,
		// Approval links go stale; a week is well inside PayPal's window and
		// long enough that a buyer who takes an hour to decide still reuses
		// the subscription instead of accumulating approvable duplicates.
		isFresh: Date.now() < createTime + 7 * 24 * 60 * 60 * 1000,
		hasApprovalLink: Boolean(approvalUrl),
	});

	if (isLive) {
		// The buyer approved and PayPal already charged.  Make sure the
		// MeterPal-side state is stamped and the plan attached (idempotent) —
		// the approval may have landed before we recorded it.
		if (cusRow?.paypal_payment_status !== "active") {
			await activatePaypalSubscription(existing!);
			logger.info({
				msg: "paypal checkout: activated already-approved subscription",
				subscriptionId: existing!.id,
				status: paypalStatus,
				customerId,
			});
		}
	}

	if (action.type === "already_paid") {
		// Already paying for THIS PayPal plan: the money moved through PayPal
		// already, so there is nothing to buy and no redirect.  Returning null
		// tells the caller to sync the MeterPal plan instead of charging the
		// buyer again.
		logger.info({
			msg: "paypal checkout: subscription already active on this plan (verified with paypal)",
			subscriptionId: existing!.id,
			status: paypalStatus,
			customerId,
			planId,
		});
		return null;
	}

	if (action.type === "revise") {
		// Paying for a DIFFERENT PayPal plan: change the existing subscription
		// instead of minting a second one — two live subscriptions means the
		// buyer is billed twice.  PayPal's revise returns a fresh approval
		// link for the change.
		try {
			const revised = await reviseSubscription({
				client,
				subscriptionId: existing!.id,
				planId,
				returnUrl,
				cancelUrl,
				idempotencyKey: `mp-revise-${crypto.randomUUID()}`,
			});
			const url = approvalLink(revised.links);
			if (!url) {
				throw new Error("no approval link on the revised subscription");
			}
			logger.info({
				msg: "paypal checkout: revised the live subscription to the new plan",
				subscriptionId: existing!.id,
				customerId,
				planId,
			});
			// The revised subscription has its own approval link -> its own BA
			// token -> the return route needs the mapping for it.
			await recordApprovalIntent({
				db,
				url,
				subscriptionId: existing!.id,
				orgId: org.id,
				env,
				customerId,
				productId: product.id,
				amountUsd: subAmountUsd(product),
				extraTokens: [checkoutToken],
			});
			// The customer row keeps the OLD paypal_plan_id until the buyer
			// approves the change: until then PayPal still bills the old plan.
			return url;
		} catch (err) {
			// Do NOT fall back to minting a second subscription here — that
			// would bill the buyer for both plans.
			logger.error({
				msg: "paypal checkout: could not revise the live subscription",
				subscriptionId: existing!.id,
				customerId,
				planId,
				error: String(err),
			});
			throw new RecaseError({
				message: "Could not switch the PayPal subscription to the new plan",
				statusCode: 502,
			});
		}
	}

	if (action.type === "reuse_approval") {
		// Reuse the approval link this customer already has.  Minting a second
		// subscription would leave another one waiting to be approved — an
		// extra real charge if the buyer clicks both.
		logger.info({
			msg: "paypal checkout: reusing the pending approval link",
			subscriptionId: existing!.id,
			status: paypalStatus,
			customerId,
		});
		// The mapping may be missing (the subscription was created before the
		// mapping was recorded, or the row was cleared) — record it again so
		// the buyer's return from PayPal can be resolved.
		await recordApprovalIntent({
			db,
			url: approvalUrl!,
			subscriptionId: existing!.id,
			orgId: org.id,
			env,
			customerId,
			productId: product.id,
			amountUsd: subAmountUsd(product),
		});
		return approvalUrl!;
	}

	if (action.type === "cancel_and_recreate" && existing) {
		// Stale, or superseded by a different plan — cancel it so it can
		// never be approved later (which would charge the buyer).
		await cancelSubscription(
			client,
			existing.id,
			"Superseded by a new MeterPal checkout",
		).catch((err) => {
			// PayPal refuses to cancel a subscription that was never activated
			// (404).  Best effort — we stop tracking it below.
			logger.warn({
				msg: "paypal checkout: could not cancel the stale subscription",
				subscriptionId: existing.id,
				customerId,
				error: String(err),
			});
		});
	}

	// No live or reusable subscription -> mint a fresh one and send the
	// buyer to PayPal to approve it.
	const subscription = await createSubscription({
		client,
		planId,
		customId: customerId,
		subscriberEmail: customer.email ?? undefined,
		returnUrl,
		cancelUrl,
		brandName: (org.name ?? "MeterPal").slice(0, 127),
		idempotencyKey: `mp-sub-${crypto.randomUUID()}`,
	});

	// Stamp the pending subscription so retries reuse it instead of minting
	// duplicates.  Cleared/replaced on activation (status -> active).
	await db
		.update(customers)
		.set({
			paypal_subscription_id: subscription.id,
			paypal_plan_id: planId,
			paypal_payment_status: "pending",
		})
		.where(eq(customers.internal_id, customer.internal_id));

	const url = approvalLink(subscription.links);
	if (!url) {
		throw new RecaseError({
			message: "PayPal subscription returned no approval link",
			statusCode: 500,
		});
	}

	// Map the keys the buyer's redirect can carry (our checkout token from the
	// return URL, and the BA-... billing-agreement token from the approval
	// URL) to the subscription id (I-...) — the browser return route resolves
	// activations through this row after the buyer approves.
	await recordApprovalIntent({
		db,
		url,
		subscriptionId: subscription.id,
		orgId: org.id,
		env,
		customerId,
		productId: product.id,
		amountUsd: subAmountUsd(product),
		extraTokens: [checkoutToken],
	});

	return url;
}

// Re-export for callers that only want the type.
export type { OrderResponse };
