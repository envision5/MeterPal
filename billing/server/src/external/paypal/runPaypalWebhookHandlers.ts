// billing/server/src/external/paypal/runPaypalWebhookHandlers.ts
//
// Dispatches PayPal webhook events to MeterPal's wallet + entitlement
// lifecycle.  Mirrors `external/stripe/runStripeWebhookHandlers.ts`.
//
// Money-in contract (1 credit = 1 USD against the org's credit feature):
//   - PAYMENT.CAPTURE.COMPLETED  (one-off credit pack)  -> grant by capture amount
//   - PAYMENT.SALE.COMPLETED     (recurring cycle paid) -> grant by sale amount
//   - INVOICING.INVOICE.PAID     (overage invoice)      -> grant by invoice total
//   - PAYMENT.CAPTURE.REFUNDED / REVERSED              -> negative grant (correction)
//
// Customer resolution (in order, first hit wins — email is last-resort):
//   1. custom_id   — we stamp customer ids on orders ("mp:<cus>:<prod>") and
//                    subscriptions at checkout creation
//   2. payer_id    — persisted on customers.paypal_payer_id at first sight
//   3. email       — legacy baseline behavior
//
// Idempotency: every handler is safe to replay.  PayPal retries up to 25
// times over 3 days on 5xx; we dedupe by event.id using the
// `stripe_webhook_events` table (event ids prefixed with "paypal:"), and
// every wallet grant dedupes on its own idempotency key.

import { and, eq } from "drizzle-orm";
import {
	customers,
	paypalCatalogMap,
	stripeWebhookEvents,
	walletLedger,
	type AppEnv,
	type DbCustomer,
} from "@autumn/shared";
import { db } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import { createWorkerContext } from "@/queue/createWorkerContext.js";
import { updateBalanceV2 } from "@/internal/balances/updateBalance/v2/updateBalanceV2.js";
import { paypalFetch } from "./client.js";

interface PayPalEvent {
	id: string;
	type: string;
	resource: any;
}

const HANDLED_TYPES = new Set([
	"BILLING.SUBSCRIPTION.CREATED",
	"BILLING.SUBSCRIPTION.ACTIVATED",
	"BILLING.SUBSCRIPTION.RE-ACTIVATED",
	"BILLING.SUBSCRIPTION.UPDATED",
	"BILLING.SUBSCRIPTION.SUSPENDED",
	"BILLING.SUBSCRIPTION.CANCELLED",
	"BILLING.SUBSCRIPTION.EXPIRED",
	"BILLING.SUBSCRIPTION.PAYMENT.FAILED",
	"PAYMENT.SALE.COMPLETED",
	"PAYMENT.SALE.REFUNDED",
	"PAYMENT.SALE.REVERSED",
	"PAYMENT.CAPTURE.COMPLETED",
	"PAYMENT.CAPTURE.REFUNDED",
	"PAYMENT.CAPTURE.REVERSED",
	"CHECKOUT.ORDER.APPROVED",
	"INVOICING.INVOICE.PAID",
]);

/** The org's credit feature (wallet currency). Single-credit-system convention. */
function creditFeatureId(): string {
	return process.env.METERPAL_CREDIT_FEATURE_ID ?? "ai_tokens";
}

export async function handlePaypalEvent(event: PayPalEvent): Promise<void> {
	if (!HANDLED_TYPES.has(event.type)) {
		logger.info({ msg: "paypal: ignoring unhandled event", eventType: event.type });
		return;
	}

	// Idempotency: skip if we've already processed this event id.
	// The Stripe-side table is reused; the "paypal:" prefix disambiguates.
	const [seen] = await db
		.select({ eventId: stripeWebhookEvents.event_id })
		.from(stripeWebhookEvents)
		.where(eq(stripeWebhookEvents.event_id, `paypal:${event.id}`))
		.limit(1);
	if (seen) {
		logger.info({ msg: "paypal: event already processed", eventId: event.id });
		return;
	}

	try {
		await dispatch(event);
	} finally {
		// Record after success (or partial failure); if dispatch throws,
		// the 5xx causes PayPal to retry and the next attempt re-enters.
		await db
			.insert(stripeWebhookEvents)
			.values({
				event_id: `paypal:${event.id}`,
				payload: event as unknown as Record<string, unknown>,
			})
			.onConflictDoNothing();
	}
}

async function dispatch(event: PayPalEvent): Promise<void> {
	switch (event.type) {
		case "BILLING.SUBSCRIPTION.ACTIVATED":
		case "BILLING.SUBSCRIPTION.CREATED":
		case "BILLING.SUBSCRIPTION.RE-ACTIVATED":
		case "BILLING.SUBSCRIPTION.UPDATED":
			await onSubscriptionActive(event);
			break;
		case "BILLING.SUBSCRIPTION.SUSPENDED":
		case "BILLING.SUBSCRIPTION.CANCELLED":
		case "BILLING.SUBSCRIPTION.EXPIRED":
			await onSubscriptionEnded(event);
			break;
		case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
			await onPaymentFailed(event);
			break;
		case "PAYMENT.SALE.COMPLETED":
			await onSaleCompleted(event);
			break;
		case "PAYMENT.SALE.REFUNDED":
		case "PAYMENT.SALE.REVERSED":
		case "PAYMENT.CAPTURE.REFUNDED":
		case "PAYMENT.CAPTURE.REVERSED":
			await onRefund(event);
			break;
		case "PAYMENT.CAPTURE.COMPLETED":
			await onCaptureCompleted(event);
			break;
		case "CHECKOUT.ORDER.APPROVED":
			// Early signal only — the money event is PAYMENT.CAPTURE.COMPLETED.
			logger.info({ msg: "paypal order approved", orderId: event.resource?.id });
			break;
		case "INVOICING.INVOICE.PAID":
			await onInvoicePaid(event);
			break;
		default:
			// already filtered above
			break;
	}
}

// ---------- customer resolution ----------

async function resolveCustomer(opts: {
	customId?: string | null;
	payerId?: string | null;
	orgId?: string | null;
	email?: string | null;
}): Promise<DbCustomer | null> {
	const { customId, payerId, orgId, email } = opts;

	if (customId) {
		const [cus] = await db
			.select()
			.from(customers)
			.where(eq(customers.id, customId))
			.limit(1);
		if (cus) return cus;
	}

	if (payerId) {
		const conds = orgId
			? and(
					eq(customers.paypal_payer_id, payerId),
					eq(customers.org_id, orgId),
				)
			: eq(customers.paypal_payer_id, payerId);
		const [cus] = await db.select().from(customers).where(conds).limit(1);
		if (cus) return cus;
	}

	if (email) {
		const [cus] = await db
			.select()
			.from(customers)
			.where(eq(customers.email, email))
			.limit(1);
		if (cus) return cus;
	}

	return null;
}

async function stampPayerId(
	customerId: string | null | undefined,
	payerId?: string | null,
): Promise<void> {
	if (!payerId || !customerId) return;
	const [cus] = await db
		.select({ payer: customers.paypal_payer_id })
		.from(customers)
		.where(eq(customers.id, customerId))
		.limit(1);
	if (cus?.payer) return; // already linked (first link wins)
	await db
		.update(customers)
		.set({ paypal_payer_id: payerId })
		.where(eq(customers.id, customerId));
}

// ---------- wallet grants ----------

/**
 * Grants `amountUsd` credits to the customer's wallet: one idempotent
 * wallet_ledger row, then the real balance increment through the same
 * worker-context machinery the queue uses.
 * Returns false when the grant was a replay (already applied).
 */
async function grantWalletCredits({
	customer,
	amountUsd,
	idempotencyKey,
	eventName,
	metadata,
}: {
	customer: DbCustomer;
	amountUsd: number;
	idempotencyKey: string;
	eventName: string;
	metadata?: Record<string, unknown>;
}): Promise<boolean> {
	const customerId = customer.id;
	if (!customerId || !amountUsd || Number.isNaN(amountUsd)) return false;

	const inserted = await db
		.insert(walletLedger)
		.values({
			customer_id: customerId,
			kind: amountUsd >= 0 ? "topup" : "correction",
			amount_usd: amountUsd,
			credits_delta: amountUsd,
			event_name: eventName,
			idempotency_key: idempotencyKey,
			metadata: { source: "paypal", ...(metadata ?? {}) },
		})
		.onConflictDoNothing()
		.returning({ id: walletLedger.id });
	if (inserted.length === 0) {
		logger.info({ msg: "paypal: grant replay skipped", idempotencyKey });
		return false;
	}

	const ctx = await createWorkerContext({
		db,
		payload: {
			orgId: customer.org_id,
			env: customer.env as AppEnv,
			customerId,
			requestId: idempotencyKey,
		},
		logger,
	});
	if (!ctx) {
		logger.error({
			msg: "paypal: could not build worker context for grant",
			idempotencyKey,
			customerId,
		});
		return false;
	}

	try {
		await updateBalanceV2({
			ctx,
			params: {
				customer_id: customerId,
				feature_id: creditFeatureId(),
				add_to_balance: amountUsd,
			},
		});
	} catch (err) {
		logger.error({
			msg: "paypal: balance update failed after ledger insert",
			idempotencyKey,
			error: String(err),
		});
	}
	return true;
}

// ---------- handlers ----------

async function onSubscriptionActive(event: PayPalEvent): Promise<void> {
	const sub = event.resource;
	const paypalSubscriptionId = sub?.id;
	const planId = sub?.plan_id;
	const payerId = sub?.subscriber?.payer_id ?? null;
	const subscriberEmail = sub?.subscriber?.email_address ?? null;
	const customId = sub?.custom_id ?? null;
	const status = sub?.status;

	if (!paypalSubscriptionId) return;
	if (!["ACTIVE", "APPROVED"].includes(status ?? "")) return;

	const cust = await resolveCustomer({ customId, payerId, email: subscriberEmail });
	if (!cust?.id) {
		logger.warn({
			msg: "paypal: subscription for unknown customer",
			paypalSubscriptionId,
			customId,
		});
		return;
	}

	await stampPayerId(cust.id, payerId);
	await db
		.update(customers)
		.set({
			paypal_subscription_id: paypalSubscriptionId,
			paypal_plan_id: planId,
			paypal_payment_status: "active",
		})
		.where(eq(customers.id, cust.id));

	// Resolve the product behind this PayPal plan via the catalog map, falling
	// back to the id-convention matcher from the baseline.
	const [mapRow] = planId
		? await db
				.select()
				.from(paypalCatalogMap)
				.where(eq(paypalCatalogMap.paypal_plan_id, planId))
				.limit(1)
		: [];
	const planKey = mapRow?.product_id ?? planKeyForPlanId(planId);

	// Trigger provisioning (LiteLLM key + entitlements) via the same
	// trigger the Stripe path uses.
	const { onSubscriptionActive: provisionActive } = await import(
		"@/internal/keys/litellmWebhookTriggers.js"
	);
	await provisionActive({ db } as any, {
		customer_id: cust.id,
		plan_key: planKey,
	});
}

async function onSubscriptionEnded(event: PayPalEvent): Promise<void> {
	const sub = event.resource;
	const paypalSubscriptionId = sub?.id;
	if (!paypalSubscriptionId) return;

	const [cust] = await db
		.select({ id: customers.id })
		.from(customers)
		.where(eq(customers.paypal_subscription_id, paypalSubscriptionId))
		.limit(1);
	const customerId = cust?.id;
	if (!customerId) return;

	await db
		.update(customers)
		.set({
			paypal_payment_status: event.type.endsWith("SUSPENDED")
				? "suspended"
				: "cancelled",
		})
		.where(eq(customers.id, customerId));

	const { onSubscriptionCancelled } = await import(
		"@/internal/keys/litellmWebhookTriggers.js"
	);
	await onSubscriptionCancelled({ db } as any, {
		customer_id: customerId,
		reason: event.type,
	});
}

async function onPaymentFailed(event: PayPalEvent): Promise<void> {
	const sub = event.resource;
	const subId = sub?.id;
	if (!subId) return;

	// Set customer to grace state.  The user can retry payment; PayPal
	// will retry 4 times over 4 days before sending BILLING.SUBSCRIPTION.SUSPENDED.
	const [cust] = await db
		.select({ id: customers.id })
		.from(customers)
		.where(eq(customers.paypal_subscription_id, subId))
		.limit(1);
	const customerId = cust?.id;
	if (customerId) {
		await db
			.update(customers)
			.set({ paypal_payment_status: "failed" })
			.where(eq(customers.id, customerId));
	}
}

async function onSaleCompleted(event: PayPalEvent): Promise<void> {
	// A recurring subscription payment landed.  Resolve the subscriber via the
	// billing agreement (subscription id), then credit the wallet by the sale
	// amount (1 credit = 1 USD).
	const saleId = event.resource?.id;
	const subscriptionId = event.resource?.billing_agreement_id;
	const amount = parseFloat(event.resource?.amount?.total ?? "0");

	if (!saleId || !amount) return;

	let cust: DbCustomer | null = null;
	if (subscriptionId) {
		const [row] = await db
			.select()
			.from(customers)
			.where(eq(customers.paypal_subscription_id, subscriptionId))
			.limit(1);
		cust = row ?? null;
	}
	if (!cust) {
		cust = await resolveCustomer({
			email: event.resource?.payer?.email_address ?? null,
		});
	}
	if (!cust) {
		logger.warn({
			msg: "paypal: sale for unknown subscriber",
			saleId,
			subscriptionId,
		});
		return;
	}

	await grantWalletCredits({
		customer: cust,
		amountUsd: amount,
		idempotencyKey: `paypal-sale:${saleId}`,
		eventName: "wallet_topup",
		metadata: { event_type: event.type, subscription_id: subscriptionId },
	});
}

async function onRefund(event: PayPalEvent): Promise<void> {
	// Reversal / chargeback.  Negative wallet grant, idempotent by refund id.
	const amount = parseFloat(event.resource?.amount?.total ?? "0");
	if (!amount) return;

	const cust = await resolveCustomer({
		email: event.resource?.payer?.email_address ?? null,
	});
	if (!cust) return;

	await grantWalletCredits({
		customer: cust,
		amountUsd: -Math.abs(amount),
		idempotencyKey: `paypal-refund:${event.resource?.id}`,
		eventName: "refund",
		metadata: { event_type: event.type },
	});
}

async function onCaptureCompleted(event: PayPalEvent): Promise<void> {
	// A one-shot wallet top-up landed.  The capture webhook carries the order
	// id in supplementary_data.related_ids.order_id — fetch the order to read
	// the custom_id we stamped at checkout ("mp:<customer_id>:<product_id>").
	const capture = event.resource;
	const captureId = capture?.id;
	const amount = parseFloat(capture?.amount?.value ?? "0");
	const currency = (capture?.amount?.currency_code ?? "USD").toUpperCase();
	if (!captureId || !amount) return;
	if (currency !== "USD") {
		logger.warn({ msg: "paypal capture: unsupported currency", captureId, currency });
		return;
	}

	const orderId = capture?.supplementary_data?.related_ids?.order_id;
	let customId: string | null = capture?.custom_id ?? null;

	if (!customId && orderId) {
		try {
			const order = await paypalFetch<{
				purchase_units?: Array<{ custom_id?: string }>;
			}>(`/v2/checkout/orders/${orderId}`, { method: "GET" });
			customId = order.purchase_units?.[0]?.custom_id ?? null;
		} catch (err) {
			logger.warn({
				msg: "paypal: order fetch failed",
				orderId,
				err: String(err),
			});
		}
	}

	let customCustomerId: string | undefined;
	if (customId?.startsWith("mp:")) {
		customCustomerId = customId.split(":")[1];
	}

	const cust = await resolveCustomer({
		customId: customCustomerId,
		payerId: capture?.payer?.payer_id ?? null,
		email: capture?.payer?.email_address ?? null,
	});
	if (!cust) {
		logger.warn({ msg: "paypal capture: no customer for payer", captureId });
		return;
	}

	await stampPayerId(cust.id, capture?.payer?.payer_id ?? null);

	await grantWalletCredits({
		customer: cust,
		amountUsd: amount,
		idempotencyKey: `paypal-capture:${captureId}`,
		eventName: "wallet_topup",
		metadata: { capture_id: captureId, order_id: orderId ?? null },
	});
}

async function onInvoicePaid(event: PayPalEvent): Promise<void> {
	// An overage invoice was paid.  The invoice resource carries our reference
	// ("mp:<customer_id>") and the item total.
	const invoice = event.resource;
	const invoiceId = invoice?.id;
	const reference: string | undefined = invoice?.detail?.reference;
	const amount = parseFloat(
		invoice?.amount?.breakdown?.item_total?.value ??
			invoice?.amount?.value ??
			"0",
	);
	if (!invoiceId || !amount) return;

	const customCustomerId = reference?.startsWith("mp:")
		? reference.slice(3)
		: undefined;

	const cust = await resolveCustomer({
		customId: customCustomerId,
		email:
			invoice?.primary_recipients?.[0]?.billing_info?.email_address ?? null,
	});
	if (!cust) {
		logger.warn({
			msg: "paypal: invoice paid for unknown customer",
			invoiceId,
			reference,
		});
		return;
	}

	await grantWalletCredits({
		customer: cust,
		amountUsd: amount,
		idempotencyKey: `paypal-invoice:${invoiceId}`,
		eventName: "invoice_paid",
		metadata: { invoice_id: invoiceId, reference },
	});
}

function planKeyForPlanId(planId: string | undefined): string {
	if (!planId) return "pro";
	// Legacy fallback when the plan is not in paypal_catalog_map:
	if (planId.includes("ultra")) return "ultra";
	if (
		planId.includes("pro_plus") ||
		planId.includes("pro-plus") ||
		planId.includes("proplus")
	)
		return "pro_plus";
	if (planId.includes("pro")) return "pro";
	return "free";
}

// Re-export for index
export { paypalFetch } from "./client.js";
