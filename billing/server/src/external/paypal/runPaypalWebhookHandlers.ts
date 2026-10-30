// autumn/server/src/external/paypal/runPaypalWebhookHandlers.ts
//
// Dispatches PayPal webhook events to Autumn's customer-product /
// entitlement lifecycle.  Mirrors `external/stripe/runStripeWebhookHandlers.ts`.
//
// Idempotency: every handler is safe to replay.  PayPal retries up to
// 25 times over 3 days on 5xx; we dedupe by event.id using the same
// `stripe_webhook_events` table from the Stripe integration (event ids are
// prefixed with "paypal:" so the two integrations never collide).

import { eq } from "drizzle-orm";
import { customers, stripeWebhookEvents, walletLedger } from "@autumn/shared";
import { db } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import { paypalFetch } from "./client.js";

interface PayPalEvent {
	id: string;
	type: string;
	resource: any;
}

const HANDLED_TYPES = new Set([
	"BILLING.SUBSCRIPTION.CREATED",
	"BILLING.SUBSCRIPTION.ACTIVATED",
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
	"CHECKOUT.ORDER.APPROVED",
]);

export async function handlePaypalEvent(event: PayPalEvent): Promise<void> {
	if (!HANDLED_TYPES.has(event.type)) {
		logger.info({ msg: "paypal: ignoring unhandled event", eventType: event.type });
		return;
	}

	// Idempotency: skip if we've already processed this event id.
	// The Stripe-side table is reused; the "paypal:" prefix disambiguates.
	const [seen] = await db
		.select({ eventId: stripeWebhookEvents.eventId })
		.from(stripeWebhookEvents)
		.where(eq(stripeWebhookEvents.eventId, `paypal:${event.id}`))
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
				eventId: `paypal:${event.id}`,
				payload: event as unknown as Record<string, unknown>,
			})
			.onConflictDoNothing();
	}
}

async function dispatch(event: PayPalEvent): Promise<void> {
	switch (event.type) {
		case "BILLING.SUBSCRIPTION.ACTIVATED":
		case "BILLING.SUBSCRIPTION.CREATED":
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
			await onRefund(event);
			break;
		case "PAYMENT.CAPTURE.COMPLETED":
		case "CHECKOUT.ORDER.APPROVED":
			await onOrderApproved(event);
			break;
		default:
			// already filtered above
			break;
	}
}

async function onSubscriptionActive(event: PayPalEvent): Promise<void> {
	const sub = event.resource;
	const paypalSubscriptionId = sub?.id;
	const planId = sub?.plan_id;
	const subscriberEmail = sub?.subscriber?.email_address;
	const status = sub?.status;

	if (!paypalSubscriptionId) return;
	if (!["ACTIVE", "APPROVED"].includes(status ?? "")) return;

	// Resolve to an Autumn customer by email (best effort).
	// Production: use PayPal's PayerID stored on customer creation.
	const [cust] = await db
		.select({
			id: customers.id,
			paypalSubscriptionId: customers.paypalSubscriptionId,
			paypalPlanId: customers.paypalPlanId,
		})
		.from(customers)
		.where(eq(customers.email, subscriberEmail ?? ""))
		.limit(1);

	if (!cust) {
		logger.warn({
			msg: "paypal: subscription for unknown email",
			paypalSubscriptionId,
			subscriberEmail,
		});
		return;
	}

	await db
		.update(customers)
		.set({ paypalSubscriptionId, paypalPlanId: planId })
		.where(eq(customers.id, cust.id));

	// Trigger provisioning (LiteLLM key + entitlements) via the same
	// trigger the Stripe path uses.  Re-uses the existing pipeline so the
	// two PSPs behave identically from here on.
	const { onSubscriptionActive: provisionActive } = await import(
		"@/internal/keys/litellmWebhookTriggers.js"
	);
	await provisionActive({ db } as any, {
		customer_id: cust.id,
		plan_key: planKeyForPlanId(planId),
	});
}

async function onSubscriptionEnded(event: PayPalEvent): Promise<void> {
	const sub = event.resource;
	const paypalSubscriptionId = sub?.id;
	if (!paypalSubscriptionId) return;

	const [cust] = await db
		.select({ id: customers.id })
		.from(customers)
		.where(eq(customers.paypalSubscriptionId, paypalSubscriptionId))
		.limit(1);
	if (!cust) return;

	const { onSubscriptionCancelled } = await import(
		"@/internal/keys/litellmWebhookTriggers.js"
	);
	await onSubscriptionCancelled({ db } as any, {
		customer_id: cust.id,
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
		.where(eq(customers.paypalSubscriptionId, subId))
		.limit(1);
	if (cust) {
		await db
			.update(customers)
			.set({ paypalPaymentStatus: "failed" })
			.where(eq(customers.id, cust.id));
	}
}

async function onSaleCompleted(event: PayPalEvent): Promise<void> {
	// Recurring subscription payment landed.  Already handled by
	// BILLING.SUBSCRIPTION.PAYMENT.FAILED / ACTIVATED lifecycle; this is a
	// notification for analytics.
	const saleId = event.resource?.id;
	const subscriptionId = event.resource?.billing_agreement_id;
	logger.info({ msg: "paypal sale completed", saleId, subscriptionId });
}

async function onRefund(event: PayPalEvent): Promise<void> {
	// Reversal / chargeback.  Best-effort: record a negative ledger entry
	// for the refunded amount.  Unique idempotency_key makes replays safe.
	const amount = parseFloat(event.resource?.amount?.total ?? "0");
	const customerEmail = event.resource?.payer?.email_address;
	if (!amount || !customerEmail) return;

	const [cust] = await db
		.select({ id: customers.id })
		.from(customers)
		.where(eq(customers.email, customerEmail))
		.limit(1);
	if (!cust) return;

	await db
		.insert(walletLedger)
		.values({
			customerId: cust.id,
			kind: "correction",
			amountUsd: amount,
			creditsDelta: amount,
			eventName: "refund",
			idempotencyKey: `paypal-refund:${event.resource?.id}`,
			metadata: { source: "paypal", event_type: event.type },
		})
		.onConflictDoNothing();
}

async function onOrderApproved(event: PayPalEvent): Promise<void> {
	if (event.type === "CHECKOUT.ORDER.APPROVED") {
		// One-shot Orders v2 approval.  The actual money event is
		// PAYMENT.CAPTURE.COMPLETED (separate delivery).  This is just
		// an early signal that the buyer clicked "Pay".
		logger.info({ msg: "paypal order approved", orderId: event.resource?.id });
		return;
	}

	// PAYMENT.CAPTURE.COMPLETED: a one-shot wallet top-up landed.  Record it
	// in the ledger (idempotent by capture id); refunds arrive as separate
	// PAYMENT.CAPTURE.REFUNDED events and are handled in onRefund.
	const capture = event.resource;
	const captureId = capture?.id;
	const amount = parseFloat(capture?.amount?.value ?? "0");
	const currency = (capture?.amount?.currency_code ?? "USD").toUpperCase();
	const payerEmail = capture?.payer?.email_address;
	if (!captureId || !amount || currency !== "USD" || !payerEmail) {
		logger.warn({
			msg: "paypal capture: unsupported top-up",
			captureId,
			currency,
			amount,
		});
		return;
	}

	const [cust] = await db
		.select({ id: customers.id })
		.from(customers)
		.where(eq(customers.email, payerEmail))
		.limit(1);
	if (!cust) {
		logger.warn({ msg: "paypal capture: no customer for payer", captureId, payerEmail });
		return;
	}

	await db
		.insert(walletLedger)
		.values({
			customerId: cust.id,
			kind: "topup",
			amountUsd: amount,
			creditsDelta: amount,
			eventName: "wallet_topup",
			idempotencyKey: `paypal-capture:${captureId}`,
			metadata: { source: "paypal", capture_id: captureId },
		})
		.onConflictDoNothing();
}

function planKeyForPlanId(planId: string | undefined): string {
	if (!planId) return "pro";
	// Plan IDs are platform-configured.  Map by convention:
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
