// billing/server/src/external/paypal/subscriptions.ts
//
// PayPal catalog + subscriptions wrappers (REST v1).
//
//  - Catalog:  POST /v1/catalog/products, POST /v1/billing/plans
//  - Subscriptions: POST /v1/billing/subscriptions (+ revise / suspend /
//    cancel / get), used for MeterPal plan checkouts.
//
// Every call goes through the ORG's PayPal client (external/paypal/
// paypalClient.ts), so a subscription is always created against the PayPal
// account that org connected.
//
// Money values are USD decimal strings ("20.00") — the billing server stores
// prices in major units, so `toUsd(amount)` is the only conversion needed.
//
// Spec: https://developer.paypal.com/api/subscriptions/v1 and
//       https://developer.paypal.com/api/catalog-products/v1

import type { PaypalClient } from "./paypalClient.js";

export type PayPalIntervalUnit = "WEEK" | "MONTH" | "YEAR";

export function toUsd(amount: number): string {
	return new Intl.NumberFormat("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(amount);
}

/** Map an Autumn BillingInterval to a PayPal frequency unit (one_off never reaches here). */
export function intervalToPaypalUnit(interval: string): PayPalIntervalUnit {
	switch (interval) {
		case "week":
			return "WEEK";
		case "year":
			return "YEAR";
		case "quarter":
		case "semi_annual":
		case "month":
		default:
			// PayPal has no QUARTER / semi-annual frequency; map to the closest
			// supported cycle (month).  MeterPal's demo plans are monthly.
			return "MONTH";
	}
}

export interface PayPalLink {
	href: string;
	rel: string;
	method?: string;
}

// ---------- Catalog ----------

export interface PayPalProduct {
	id: string;
	name: string;
	status: string;
}

export async function createCatalogProduct({
	client,
	name,
	description,
	sku,
	idempotencyKey,
}: {
	client: PaypalClient;
	name: string;
	description?: string;
	sku?: string;
	idempotencyKey?: string;
}): Promise<PayPalProduct> {
	return client.fetch<PayPalProduct>("/v1/catalog/products", {
		method: "POST",
		body: JSON.stringify({
			name,
			description: description ?? name,
			type: "SERVICE",
			category: "SOFTWARE",
			...(sku ? { sku } : {}),
		}),
		idempotencyKey,
	});
}

export interface PayPalPlan {
	id: string;
	product_id: string;
	name: string;
	status: string;
}

export async function createBillingPlan({
	client,
	productId,
	name,
	description,
	intervalUnit,
	intervalCount = 1,
	amountUsd,
	trialCycles = 0,
	idempotencyKey,
}: {
	client: PaypalClient;
	productId: string;
	name: string;
	description?: string;
	intervalUnit: PayPalIntervalUnit;
	intervalCount?: number;
	amountUsd: number;
	trialCycles?: number;
	idempotencyKey?: string;
}): Promise<PayPalPlan> {
	const billingCycles: unknown[] = [];
	if (trialCycles > 0) {
		billingCycles.push({
			frequency: { interval_unit: intervalUnit, interval_count: intervalCount },
			tenure_type: "TRIAL",
			sequence: 1,
			total_cycles: trialCycles,
			pricing_scheme: { fixed_price: { value: "0.00", currency_code: "USD" } },
		});
	}
	billingCycles.push({
		frequency: { interval_unit: intervalUnit, interval_count: intervalCount },
		tenure_type: "REGULAR",
		sequence: billingCycles.length + 1,
		total_cycles: 0, // infinite
		pricing_scheme: { fixed_price: { value: toUsd(amountUsd), currency_code: "USD" } },
	});

	return client.fetch<PayPalPlan>("/v1/billing/plans", {
		method: "POST",
		body: JSON.stringify({
			product_id: productId,
			name,
			description: description ?? name,
			status: "ACTIVE",
			billing_cycles: billingCycles,
			payment_preferences: {
				auto_bill_outstanding: true,
				setup_fee: { value: "0.00", currency_code: "USD" },
			},
		}),
		idempotencyKey,
	});
}

export async function getBillingPlan(
	client: PaypalClient,
	planId: string,
): Promise<PayPalPlan> {
	return client.fetch<PayPalPlan>(`/v1/billing/plans/${planId}`, {
		method: "GET",
	});
}

// ---------- Subscriptions ----------

export interface PayPalSubscription {
	id: string;
	plan_id: string;
	status: string;
	custom_id?: string;
	create_time?: string;
	subscriber?: {
		email_address?: string;
		payer_id?: string;
	};
	links?: PayPalLink[];
}

export interface CreateSubscriptionArgs {
	client: PaypalClient;
	planId: string;
	customId?: string;
	subscriberEmail?: string;
	returnUrl: string;
	cancelUrl: string;
	brandName?: string;
	idempotencyKey?: string;
}

/**
 * Creates a subscription and returns it; the caller reads the `approve`
 * link and redirects the buyer there.  Approval lands back on `returnUrl`
 * and PayPal then fires BILLING.SUBSCRIPTION.ACTIVATED (plus, on each cycle,
 * PAYMENT.SALE.COMPLETED).
 */
export async function createSubscription({
	client,
	planId,
	customId,
	subscriberEmail,
	returnUrl,
	cancelUrl,
	brandName,
	idempotencyKey,
}: CreateSubscriptionArgs): Promise<PayPalSubscription> {
	return client.fetch<PayPalSubscription>("/v1/billing/subscriptions", {
		method: "POST",
		body: JSON.stringify({
			plan_id: planId,
			...(customId ? { custom_id: customId } : {}),
			...(subscriberEmail
				? { subscriber: { email_address: subscriberEmail } }
				: {}),
			application_context: {
				brand_name: brandName ?? "MeterPal",
				locale: "en-US",
				user_action: "SUBSCRIBE_NOW",
				shipping_preference: "NO_SHIPPING",
				payment_method: {
					payer_selected: "PAYPAL",
					payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED",
				},
				return_url: returnUrl,
				cancel_url: cancelUrl,
			},
		}),
		idempotencyKey,
	});
}

/** Extract the buyer-approval link from a subscription/order response. */
export function approvalLink(links?: PayPalLink[]): string | null {
	const approve = links?.find(
		(l) => l.rel === "approve" || l.rel === "payer-action",
	);
	return approve?.href ?? null;
}

/**
 * Extracts the billing-agreement token from a PayPal approval link.
 *
 * Subscription approval links carry it as `ba_token`; order approval links
 * carry it as `token`.  Reading only `token` made every subscription approval
 * unmappable, so the buyer's return from PayPal could not be resolved to the
 * subscription — the customer paid and nothing happened.
 */
export function approvalTokenFromUrl(url: string): string {
	try {
		const params = new URL(url).searchParams;
		return params.get("ba_token") ?? params.get("token") ?? "";
	} catch {
		return "";
	}
}

export async function getSubscription(
	client: PaypalClient,
	subscriptionId: string,
): Promise<PayPalSubscription> {
	return client.fetch<PayPalSubscription>(
		`/v1/billing/subscriptions/${subscriptionId}`,
		{ method: "GET" },
	);
}

export async function reviseSubscription({
	client,
	subscriptionId,
	planId,
	returnUrl,
	cancelUrl,
	idempotencyKey,
}: {
	client: PaypalClient;
	subscriptionId: string;
	planId: string;
	returnUrl?: string;
	cancelUrl?: string;
	idempotencyKey?: string;
}): Promise<PayPalSubscription & { links?: PayPalLink[] }> {
	return client.fetch(`/v1/billing/subscriptions/${subscriptionId}/revise`, {
		method: "POST",
		body: JSON.stringify({
			plan_id: planId,
			...(returnUrl && cancelUrl
				? {
						application_context: {
							user_action: "CONTINUE",
							shipping_preference: "NO_SHIPPING",
							return_url: returnUrl,
							cancel_url: cancelUrl,
						},
					}
				: {}),
		}),
		idempotencyKey,
	});
}

export async function suspendSubscription(
	client: PaypalClient,
	subscriptionId: string,
	note = "Suspended by MeterPal",
): Promise<void> {
	await client.fetch(
		`/v1/billing/subscriptions/${subscriptionId}/suspend`,
		{
			method: "POST",
			body: JSON.stringify({ note }),
		},
	);
}

/**
 * Cancels a subscription.
 *
 * PayPal's v1 cancel endpoint takes a `reason` (1..128 chars) — sending
 * `note` there is rejected as a malformed body, so the cancellation never
 * went through and a stale subscription stayed approvable.
 */
export async function cancelSubscription(
	client: PaypalClient,
	subscriptionId: string,
	reason = "Cancelled by MeterPal",
): Promise<void> {
	await client.fetch(`/v1/billing/subscriptions/${subscriptionId}/cancel`, {
		method: "POST",
		body: JSON.stringify({ reason: reason.slice(0, 128) }),
	});
}

// ---------- Webhook registration (so local dev needs no dashboard clicking) ----------

export interface PayPalWebhook {
	id: string;
	url: string;
	event_types: Array<{ name: string; status: string }>;
}

export async function createWebhook({
	client,
	url,
	eventTypes,
	idempotencyKey,
}: {
	client: PaypalClient;
	url: string;
	eventTypes: string[];
	idempotencyKey?: string;
}): Promise<PayPalWebhook> {
	return client.fetch<PayPalWebhook>("/v1/notifications/webhooks", {
		method: "POST",
		body: JSON.stringify({
			url,
			event_types: eventTypes.map((name) => ({ name })),
		}),
		idempotencyKey,
	});
}

export async function listWebhooks(client: PaypalClient): Promise<{
	webhooks: PayPalWebhook[];
}> {
	return client.fetch<{ webhooks: PayPalWebhook[] }>(
		"/v1/notifications/webhooks",
		{ method: "GET" },
	);
}
