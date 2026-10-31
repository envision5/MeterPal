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
	paypalCatalogMap,
	type FullProduct,
	type Organization,
	type Price,
} from "@autumn/shared";
import { and, eq } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import type { AttachParams } from "@/internal/customers/cusProducts/AttachParams.js";
import { createOrder, type OrderResponse } from "@/external/paypal/orders.js";
import {
	approvalLink,
	createBillingPlan,
	createCatalogProduct,
	createSubscription,
	intervalToPaypalUnit,
} from "@/external/paypal/subscriptions.js";
import type { AppEnv } from "@autumn/shared";

export function isPaypalConfigured(): boolean {
	return !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET;
}

/** True when every price on the attach is a one-off fixed charge (credit packs). */
export function pricesAreOneOff(prices: Price[]): boolean {
	return (
		prices.length > 0 &&
		prices.every(
			(p) =>
				p.config.type === PriceType.Fixed &&
				(p.config as { interval?: BillingInterval }).interval ===
					BillingInterval.OneOff,
		)
	);
}

/** First fixed recurring price on the product — the PayPal plan amount. */
export function recurringFixedPrice(product: FullProduct): Price | null {
	return (
		product.prices.find(
			(p) =>
				p.config.type === PriceType.Fixed &&
				(p.config as { interval?: BillingInterval }).interval !==
					BillingInterval.OneOff,
		) ?? null
	);
}

function toUsd(amount: number): string {
	return new Intl.NumberFormat("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(amount);
}

function fallbackUrls(org: Organization): { returnUrl: string; cancelUrl: string } {
	const base =
		process.env.METERPAL_CHECKOUT_RETURN_URL ?? "http://localhost:5173";
	return { returnUrl: base, cancelUrl: base };
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
		amount: number;
		interval: BillingInterval;
		interval_count?: number;
	};

	const paypalProduct = await createCatalogProduct({
		name: `${org.slug ?? org.id} — ${product.name}`.slice(0, 127),
		description: `MeterPal plan ${product.id} (${org.slug ?? org.id})`.slice(
			0,
			127,
		),
		sku: `${org.id}:${env}:${product.id}`.slice(0, 127),
		idempotencyKey: `mp-catprod-${org.id}-${env}-${product.id}`,
	});

	const plan = await createBillingPlan({
		productId: paypalProduct.id,
		name: product.name.slice(0, 127),
		description: `MeterPal plan ${product.id}`.slice(0, 127),
		intervalUnit: intervalToPaypalUnit(config.interval),
		intervalCount: config.interval_count ?? 1,
		amountUsd: config.amount,
		idempotencyKey: `mp-plan-${org.id}-${env}-${product.id}`,
	});

	const row = {
		org_id: org.id,
		env,
		product_id: product.id,
		paypal_product_id: paypalProduct.id,
		paypal_plan_id: plan.id,
		name: product.name,
		interval: config.interval,
		amount_usd: config.amount,
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
}): Promise<string> {
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

	const { returnUrl, cancelUrl } = successUrl
		? { returnUrl: successUrl, cancelUrl: successUrl }
		: fallbackUrls(org);

	if (pricesAreOneOff(prices)) {
		// One-off credit pack -> Orders v2.
		const fixed = prices.filter((p) => p.config.type === PriceType.Fixed);
		const total = fixed.reduce((sum, p) => sum + (p.config as { amount: number }).amount, 0);
		if (total <= 0) {
			throw new RecaseError({
				message: "PayPal order total must be positive",
				statusCode: 400,
			});
		}

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
						items: fixed.map((p, i) => ({
							name: `${product.name}`.slice(0, 127),
							quantity: "1",
							unit_amount: {
								currency_code: "USD",
								value: toUsd((p.config as { amount: number }).amount),
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
	const subscription = await createSubscription({
		planId,
		customId: customerId,
		subscriberEmail: customer.email ?? undefined,
		returnUrl,
		cancelUrl,
		brandName: (org.name ?? "MeterPal").slice(0, 127),
		idempotencyKey: `mp-sub-${crypto.randomUUID()}`,
	});

	const url = approvalLink(subscription.links);
	if (!url) {
		throw new RecaseError({
			message: "PayPal subscription returned no approval link",
			statusCode: 500,
		});
	}
	return url;
}

// Re-export for callers that only want the type.
export type { OrderResponse };
