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

import {
	BillingInterval,
	PriceType,
	RecaseError,
	customers,
	paypalCatalogMap,
	paypalOrderIntents,
	type FullProduct,
	type Organization,
	type Price,
} from "@autumn/shared";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import type { AttachParams } from "@/internal/customers/cusProducts/AttachParams.js";
import { createOrder, type OrderResponse } from "@/external/paypal/orders.js";
import { paypalFetch } from "@/external/paypal/client.js";
import {
	approvalLink,
	cancelSubscription,
	createBillingPlan,
	createCatalogProduct,
	createSubscription,
	getSubscription,
	intervalToPaypalUnit,
} from "@/external/paypal/subscriptions.js";
import { activatePaypalSubscription } from "@/external/paypal/runPaypalWebhookHandlers.js";
import type { AppEnv } from "@autumn/shared";
import { logger } from "@/external/logtail/logtailUtils.js";
import { isStripeConnected } from "@/internal/orgs/orgUtils.js";

export function isPaypalConfigured(): boolean {
	return !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET;
}

/**
 * True when this org bills through PayPal end-to-end (PayPal configured,
 * no Stripe connected) — Stripe-coupled plumbing should skip itself.
 */
export function isPaypalNativeOrg(ctx: {
	org: Organization;
	env: AppEnv;
}): boolean {
	return isPaypalConfigured() && !isStripeConnected({ org: ctx.org, env: ctx.env });
}

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
 */
function paypalRedirectUrls(): { returnUrl: string; cancelUrl: string } {
	const base = process.env.METERPAL_PUBLIC_URL ?? "http://localhost:8080";
	return {
		returnUrl: `${base}/paypal/return`,
		cancelUrl: `${base}/paypal/return?cancelled=1`,
	};
}

/**
 * PayPal product id for a plan.  PayPal's model is one catalog product per
 * service with many billing plans underneath — so a shared product id via
 * `PAYPAL_PRODUCT_ID` is the preferred setup.  Otherwise one product is
 * auto-created per MeterPal plan through /v1/catalog/products (some sandbox
 * accounts return 404 on that endpoint — set PAYPAL_PRODUCT_ID there).
 */
async function resolvePaypalProductId({
	org,
	env,
	product,
	existingProductId,
}: {
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
	db,
	org,
	env,
	product,
}: {
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
	if (existing?.paypal_plan_id) return existing.paypal_plan_id;

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
		org,
		env,
		product,
		existingProductId: existing?.paypal_product_id ?? null,
	});

	const plan = await createBillingPlan({
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
	db,
	customerId,
	exceptOrderId,
}: {
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
		try {
			// Only CREATED orders are cancellable at PayPal; best-effort either
			// way — APPROVED-but-uncaptured ones are left to expire, charging
			// nobody.
			await paypalFetch(
				`/v2/checkout/orders/${intent.order_id}/cancel`,
				{ method: "POST", body: "{}" },
			);
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
	const { returnUrl, cancelUrl } = paypalRedirectUrls();

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
				const existing = await paypalFetch<Record<string, any>>(
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
		await abandonOtherIntents({ db, customerId });

		// Record the intent so the finalize/poll endpoint can capture the
		// order without depending on PayPal's browser redirect.
		const order = await createOrder(
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
	const planId = await ensurePaypalPlan({ db, org, env, product });

	// SUBSCRIPTION REUSE: every plan click must NOT mint a new PayPal
	// subscription — each buyer approval is an immediate real charge.  Track
	// the customer's latest subscription on the customer row and:
	//   APPROVED/ACTIVE -> the buyer already paid; activate it, never re-mint
	//   CREATED (same plan, fresh) -> reuse its approval link
	//   CREATED (stale)  -> cancel it at PayPal, mint fresh
	const appUrl =
		process.env.METERPAL_CHECKOUT_RETURN_URL ?? "http://localhost:5173";
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

	if (
		cusRow?.paypal_subscription_id &&
		cusRow.paypal_payment_status === "active" &&
		cusRow.paypal_plan_id === planId
	) {
		// Already an active subscriber to this plan — nothing to buy, and no
		// redirect: returning null tells the SDK to surface "already
		// subscribed" instead of bouncing the app to a success page.
		logger.info({
			msg: "paypal checkout: customer already active on plan",
			customerId,
			planId,
		});
		return null;
	}

	if (
		cusRow?.paypal_subscription_id &&
		cusRow.paypal_payment_status === "pending"
	) {
		try {
			const existing = await getSubscription(cusRow.paypal_subscription_id);
			const createTime = existing?.create_time
				? new Date(existing.create_time).getTime()
				: 0;
			const isFresh = Date.now() < createTime + 30 * 60 * 1000;

			if (["APPROVED", "ACTIVE"].includes(existing?.status ?? "")) {
				// The buyer already approved — and PayPal already charged — this
				// subscription.  Activate it (idempotent).  Same plan -> no
				// checkout (no double-bill); different plan -> success page
				// (the buyer's new plan is now live).
				await activatePaypalSubscription(existing);
				logger.info({
					msg: "paypal checkout: activated already-approved subscription",
					subscriptionId: existing.id,
					customerId,
				});
				return cusRow?.paypal_plan_id === planId ? null : `${appUrl}?payment=success`;
			}
			if (existing?.status === "CREATED" && isFresh) {
				const url = approvalLink(existing.links);
				if (url && cusRow.paypal_plan_id === planId) {
					logger.info({
						msg: "paypal checkout: reusing pending subscription",
						subscriptionId: existing.id,
						customerId,
					});
					return url;
				}
			}
			if (existing?.status === "CREATED") {
				// Stale or superseded by a different plan — cancel so it can
				// never be approved later (which would charge the buyer).
				await cancelSubscription(
					existing.id,
					"Superseded by a new MeterPal checkout",
				).catch(() => {
					// best-effort — still stop tracking it below
				});
			}
			// anything else (CANCELLED/SUSPENDED/EXPIRED) -> mint fresh
		} catch {
			// subscription lookup failed (e.g. deleted) — mint fresh
		}
	}

	const subscription = await createSubscription({
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

	// Map the return token (BA-... billing-agreement token from the approval
	// URL) to the subscription id (I-...) — the browser return route resolves
	// activations through this row after the buyer approves.
	const baToken = new URL(url).searchParams.get("token") ?? "";
	const subPrice = recurringFixedPrice(product);
	const subAmount = subPrice ? priceAmountUsd(subPrice) ?? 0 : 0;
	await db
		.insert(paypalOrderIntents)
		.values({
			order_id: baToken,
			subscription_id: subscription.id,
			org_id: org.id,
			env,
			customer_id: customerId,
			product_id: product.id,
			amount_usd: subAmount,
			status: "pending",
		})
		.onConflictDoNothing();

	return url;
}

// Re-export for callers that only want the type.
export type { OrderResponse };
