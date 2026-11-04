// billing/server/src/external/paypal/runPaypalWebhookHandlers.ts
//
// Dispatches PayPal webhook events to MeterPal's wallet + entitlement
// lifecycle.
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
// `webhook_events` table (event ids prefixed with "paypal:"), and
// every wallet grant dedupes on its own idempotency key.

import {
	type AppEnv,
	customers,
	type DbCustomer,
	entitlements,
	features,
	invoices,
	paypalCatalogMap,
	paypalOrderIntents,
	products,
	WebhookEventType,
	walletLedger,
	webhookEvents,
} from "@autumn/shared";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import { sendSvixEvent } from "@/external/svix/svixHelpers.js";
import { updateBalanceV2 } from "@/internal/balances/updateBalance/v2/updateBalanceV2.js";
import { getPaypalClientForOrder } from "@/internal/billing/paypal/paypalOrgClient.js";
import { hasActiveCustomerProductForProduct } from "@/internal/customers/cusProducts/hasActiveCustomerProductForProduct";
import { createWorkerContext } from "@/queue/createWorkerContext.js";
import {
	paypalCaptureInvoiceId,
	paypalInvoiceRefId,
	paypalSaleInvoiceId,
	recordPaypalInvoice,
} from "./invoiceRecording.js";
import type { PaypalClient } from "./paypalClient.js";
import { PAYPAL_WEBHOOK_EVENT_TYPES } from "./webhookEventTypes.js";

interface PayPalEvent {
	id: string;
	type: string;
	resource: any;
}

/** Dispatch filter — derived from the registration list so the two never drift. */
const HANDLED_TYPES = new Set<string>(PAYPAL_WEBHOOK_EVENT_TYPES);

/** The org's credit feature (wallet currency). Single-credit-system convention. */
function creditFeatureId(): string {
	return process.env.METERPAL_CREDIT_FEATURE_ID ?? "ai_tokens";
}

export async function handlePaypalEvent(
	event: PayPalEvent,
	/** The ORG's PayPal client.  The webhook route resolves the org from
	 *  the URL, so the event is handled against the right PayPal account. */
	client?: PaypalClient,
): Promise<void> {
	if (!HANDLED_TYPES.has(event.type)) {
		logger.info({
			msg: "paypal: ignoring unhandled event",
			eventType: event.type,
		});
		return;
	}

	// Idempotency: skip if we've already processed this event id.
	// The "paypal:" prefix disambiguates PayPal ids from other processors'.
	const [seen] = await db
		.select({ eventId: webhookEvents.event_id })
		.from(webhookEvents)
		.where(eq(webhookEvents.event_id, `paypal:${event.id}`))
		.limit(1);
	if (seen) {
		logger.info({ msg: "paypal: event already processed", eventId: event.id });
		return;
	}

	// Record AFTER successful dispatch. Grant/activation idempotency makes a
	// PayPal retry of an already-applied event a safe no-op, but recording a
	// FAILED dispatch would defeat PayPal's 25-retry policy and lose the
	// money event entirely.
	try {
		await dispatch(event, client);
	} catch (error) {
		logger.error({
			msg: "paypal: dispatch failed — leaving event unrecorded so PayPal retries",
			eventId: event.id,
			eventType: event.type,
			error: String(error),
		});
		throw error;
	}
	await db
		.insert(webhookEvents)
		.values({
			event_id: `paypal:${event.id}`,
			payload: event as unknown as Record<string, unknown>,
		})
		.onConflictDoNothing();
}

async function dispatch(
	event: PayPalEvent,
	client?: PaypalClient,
): Promise<void> {
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
			await onCaptureCompleted(event, client);
			break;
		case "CUSTOMER.DISPUTE.CREATED":
		case "CUSTOMER.DISPUTE.UPDATED":
		case "CUSTOMER.DISPUTE.RESOLVED":
			await onDispute(event);
			break;
		case "CHECKOUT.ORDER.APPROVED":
			// Early signal only — the money event is PAYMENT.CAPTURE.COMPLETED.
			logger.info({
				msg: "paypal order approved",
				orderId: event.resource?.id,
			});
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

export async function resolveCustomer(opts: {
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
			? and(eq(customers.paypal_payer_id, payerId), eq(customers.org_id, orgId))
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

export async function stampPayerId(
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

/**
 * Persists the vaulted billing agreement (BA-...) behind a subscription so
 * merchant-initiated charges (auto top-ups) can reference it later.
 *
 * The checkout recorded BA token -> subscription id rows in
 * paypal_order_intents when it minted the approval link, and a token is only
 * a real billing agreement once the buyer approved — so this runs on
 * activation, never at checkout.  First stamp wins.
 */
export async function stampPaypalBillingAgreement({
	customerId,
	paypalSubscriptionId,
}: {
	customerId: string | null | undefined;
	paypalSubscriptionId: string | null | undefined;
}): Promise<void> {
	if (!customerId || !paypalSubscriptionId) return;
	const [cus] = await db
		.select({ agreement: customers.paypal_billing_agreement_id })
		.from(customers)
		.where(eq(customers.id, customerId))
		.limit(1);
	if (cus?.agreement) return; // already vaulted

	const [intent] = await db
		.select({ orderId: paypalOrderIntents.order_id })
		.from(paypalOrderIntents)
		.where(eq(paypalOrderIntents.subscription_id, paypalSubscriptionId))
		.orderBy(sql`${paypalOrderIntents.id} desc`)
		.limit(1);
	if (!intent?.orderId?.startsWith("BA-")) return;

	await db
		.update(customers)
		.set({ paypal_billing_agreement_id: intent.orderId })
		.where(eq(customers.id, customerId));
	logger.info({
		msg: "paypal: vaulted billing agreement stamped",
		customerId,
		paypalSubscriptionId,
	});
}

// ---------- wallet grants ----------

/**
 * Grants `amountUsd` credits to the customer's wallet: one idempotent
 * wallet_ledger row, then the real balance increment through the same
 * worker-context machinery the queue uses.
 * Returns false when the grant was a replay (already applied).
 */
export async function grantWalletCredits({
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
	const ledgerRowId = inserted[0].id;

	// The ledger row and the balance update are two separate writes: if the
	// balance update fails, DELETE the ledger row before propagating — the
	// unique idempotency key would otherwise block every retry (PayPal's
	// 25 redeliveries included) and the paid grant would be lost forever.
	const releaseLedgerRowAndRethrow = async (err: unknown) => {
		await db
			.delete(walletLedger)
			.where(eq(walletLedger.id, ledgerRowId))
			.catch((deleteErr) => {
				logger.error({
					msg: "paypal: failed to release ledger row after balance-update failure",
					ledgerRowId,
					idempotencyKey,
					error: String(deleteErr),
				});
			});
		throw err;
	};

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
		await releaseLedgerRowAndRethrow(
			new Error("could not build worker context for grant"),
		);
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
			msg: "paypal: balance update failed — releasing ledger row for retry",
			idempotencyKey,
			error: String(err),
		});
		await releaseLedgerRowAndRethrow(err);
	}
	return true;
}

// ---------- plan attach ----------

/**
 * Resolves the MeterPal product behind a PayPal billing plan id.
 */
async function resolveProductIdForPaypalPlan(
	paypalPlanId: string | null | undefined,
): Promise<string | undefined> {
	if (!paypalPlanId) return undefined;
	const [row] = await db
		.select({ productId: paypalCatalogMap.product_id })
		.from(paypalCatalogMap)
		.where(eq(paypalCatalogMap.paypal_plan_id, paypalPlanId))
		.limit(1);
	return row?.productId;
}

/**
 * True when the customer already holds the MeterPal plan behind their PayPal
 * subscription.  That plan carries the monthly allowance and resets on its
 * own, so a wallet grant on top of it would credit the customer twice.
 */
async function hasActiveMeterPalPlan({
	customer,
	productId,
}: {
	customer: DbCustomer;
	productId: string | undefined;
}): Promise<boolean> {
	return hasActiveCustomerProductForProduct({
		db,
		internalCustomerId: customer.internal_id,
		productId,
	});
}

/**
 * Attaches the MeterPal plan behind a PayPal subscription so MeterPal's own
 * view — subscriptions, entitlements, plan card — matches what the customer
 * is paying for on PayPal.
 *
 * Without this, an approved PayPal subscription leaves the customer on their
 * old MeterPal plan: they are billed for MeterPal Pro while MeterPal still
 * shows them on Demo Starter, and the "switch plan" button has nothing to
 * switch to.
 *
 * Returns false when the attach could not be performed, so the caller can
 * fall back to crediting the wallet directly.
 */
async function attachPaypalPlanMeterPalSide({
	customer,
	productId,
}: {
	customer: DbCustomer;
	productId: string;
}): Promise<boolean> {
	const customerId = customer.id;
	if (!customerId) {
		logger.error({
			msg: "paypal: customer has no id, cannot attach the plan",
			internalCustomerId: customer.internal_id,
			productId,
		});
		return false;
	}

	const ctx = await createWorkerContext({
		db,
		payload: {
			orgId: customer.org_id,
			env: customer.env as AppEnv,
			customerId,
			requestId: `paypal-attach:${customerId}:${productId}`,
		},
		logger,
	});
	if (!ctx) {
		logger.error({
			msg: "paypal: could not build worker context for plan attach",
			customerId,
			productId,
		});
		return false;
	}

	try {
		// Imported lazily: billingActions -> attach -> runPaypalCheckout ->
		// this module.  A static import would close that cycle at module load.
		const { billingActions } = await import("@/internal/billing/v2/actions");
		await billingActions.attach({
			ctx,
			params: {
				customer_id: customerId,
				plan_id: productId,
				redirect_mode: "never",
			},
		});
		logger.info({
			msg: "paypal: plan attached meterpal-side",
			customerId,
			productId,
		});
		return true;
	} catch (err) {
		logger.error({
			msg: "paypal: plan attach failed",
			customerId,
			productId,
			error: String(err),
		});
		return false;
	}
}

/**
 * Makes sure the MeterPal plan behind a PayPal subscription is attached to the
 * customer.  Idempotent: a customer who already holds the plan is left alone,
 * and a failed attach can be retried on the next activation event.
 */
async function ensurePaypalPlanAttached(
	customer: DbCustomer,
	paypalPlanId: string | null | undefined,
): Promise<boolean> {
	const productId = await resolveProductIdForPaypalPlan(paypalPlanId);
	if (!productId) return false;
	if (await hasActiveMeterPalPlan({ customer, productId })) return true;
	return attachPaypalPlanMeterPalSide({ customer, productId });
}

// ---------- handlers ----------

/**
 * Activates a PayPal subscription in MeterPal: links the subscription to the
 * customer, stamps the payer id and provisions the plan entitlements
 * (LiteLLM key + budget).
 *
 * Shared by the BILLING.SUBSCRIPTION.* webhook handler and the browser-return
 * route (GET /paypal/return) — locally there is no webhook tunnel, so the
 * return redirect is often what activates the subscription.  Both paths can
 * fire for the same subscription, so this is idempotent: re-activating an
 * already-active subscription is a no-op that still returns true.
 */
/**
 * Marks the approval intents that point at this subscription as settled.
 *
 * A subscription checkout records a BA- billing-agreement token -> subscription
 * id row so the buyer's return from PayPal can be resolved.  Until the buyer
 * approves, that row stays "pending" — but "pending" is also what the one-off
 * order path looks for when it abandons stale checkouts, and it would try to
 * cancel a BA token as if it were an Orders v2 id.  Settling it on activation
 * keeps the table honest and stops that cross-talk.
 */
async function markApprovalIntentsActivated(
	paypalSubscriptionId: string,
): Promise<void> {
	await db
		.update(paypalOrderIntents)
		.set({ status: "activated" })
		.where(
			and(
				eq(paypalOrderIntents.subscription_id, paypalSubscriptionId),
				eq(paypalOrderIntents.status, "pending"),
			),
		);
}

export async function activatePaypalSubscription(sub: {
	id?: string;
	plan_id?: string;
	status?: string;
	custom_id?: string | null;
	subscriber?: { payer_id?: string | null; email_address?: string | null };
}): Promise<boolean> {
	const paypalSubscriptionId = sub?.id;
	const planId = sub?.plan_id;
	const payerId = sub?.subscriber?.payer_id ?? null;
	const subscriberEmail = sub?.subscriber?.email_address ?? null;
	const customId = sub?.custom_id ?? null;
	const status = sub?.status;

	if (!paypalSubscriptionId) return false;
	if (!["ACTIVE", "APPROVED"].includes(status ?? "")) return false;

	const cust = await resolveCustomer({
		customId,
		payerId,
		email: subscriberEmail,
	});
	if (!cust?.id) {
		logger.warn({
			msg: "paypal: subscription for unknown customer",
			paypalSubscriptionId,
			customId,
		});
		return false;
	}

	// Idempotency: already linked + active for THIS subscription — nothing to
	// do (the caller still wants its success redirect, hence true).
	if (
		cust.paypal_subscription_id === paypalSubscriptionId &&
		cust.paypal_payment_status === "active"
	) {
		// The link can outlive a failed plan attach, so make sure the MeterPal
		// plan landed.  Re-attaching an already-attached plan is a no-op.
		await ensurePaypalPlanAttached(cust, planId);
		// The approval intent may still read "pending" if the first activation
		// failed after PayPal confirmed the subscription — settle it here too.
		await markApprovalIntentsActivated(paypalSubscriptionId);
		// The buyer approved, so the BA token is a real billing agreement now.
		await stampPaypalBillingAgreement({
			customerId: cust.id,
			paypalSubscriptionId,
		});
		return true;
	}

	await stampPayerId(cust.id, payerId);
	await stampPaypalBillingAgreement({
		customerId: cust.id,
		paypalSubscriptionId,
	});
	await db
		.update(customers)
		.set({
			paypal_subscription_id: paypalSubscriptionId,
			paypal_plan_id: planId,
			paypal_payment_status: "active",
		})
		.where(eq(customers.id, cust.id));

	// The buyer approved: the approval intent (BA- token -> subscription id) is
	// no longer outstanding.
	await markApprovalIntentsActivated(paypalSubscriptionId);

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

	// Trigger provisioning (LiteLLM key + entitlements) via the shared
	// subscription activation trigger.
	const { onSubscriptionActive: provisionActive } = await import(
		"@/internal/keys/litellmWebhookTriggers.js"
	);
	await provisionActive({ db } as any, {
		customer_id: cust.id,
		plan_key: planKey,
	});

	// First-cycle credit grant: the plan's monthly allowance (e.g. Pro = 100
	// credits).  Idempotent on the subscription id — renewal cycles arrive as
	// PAYMENT.SALE.COMPLETED events instead, so this fires once per
	// subscription, not once per month.
	if (mapRow?.product_id) {
		const [grant] = await db
			.select({ allowance: entitlements.allowance })
			.from(entitlements)
			.innerJoin(
				products,
				eq(products.internal_id, entitlements.internal_product_id),
			)
			.innerJoin(
				features,
				eq(features.internal_id, entitlements.internal_feature_id),
			)
			.where(
				and(
					eq(products.id, mapRow.product_id),
					eq(features.id, creditFeatureId()),
					eq(entitlements.org_id, cust.org_id),
				),
			)
			.limit(1);
		const monthlyCredits = Number(grant?.allowance ?? 0);

		// Attach the plan MeterPal-side first: the plan carries the monthly
		// allowance (and resets it every cycle), so a wallet grant on top of
		// it would credit the customer twice per cycle.  The wallet grant
		// stays as the fallback for when the plan cannot be attached.
		const planAttached = await ensurePaypalPlanAttached(cust, planId);

		if (monthlyCredits > 0 && !planAttached) {
			await grantWalletCredits({
				customer: cust,
				amountUsd: monthlyCredits,
				idempotencyKey: `paypal-sub-cycle:${paypalSubscriptionId}`,
				eventName: "subscription_cycle",
				metadata: {
					subscription_id: paypalSubscriptionId,
					plan: planKey,
					cycle: 1,
				},
			});
		}
	}

	return true;
}

async function onSubscriptionActive(event: PayPalEvent): Promise<void> {
	await activatePaypalSubscription(event.resource);
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
	const saleCurrency = (
		event.resource?.amount?.currency_code ?? "USD"
	).toUpperCase();
	if (!saleId || !amount) return;
	if (saleCurrency !== "USD") {
		// 1 credit = 1 USD — crediting a non-USD amount 1:1 would mint money.
		logger.warn({
			msg: "paypal sale: unsupported currency",
			saleId,
			currency: saleCurrency,
		});
		return;
	}

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

	const planProductId = await resolveProductIdForPaypalPlan(
		cust.paypal_plan_id,
	);

	// Self-heal the vaulted billing agreement: the sale proves the agreement
	// is live, so an org whose customers activated before the BA column
	// existed still gets stamped (the intents row maps sub -> BA token).
	await stampPaypalBillingAgreement({
		customerId: cust.id,
		paypalSubscriptionId: subscriptionId,
	});

	// The money moved either way — record the cycle payment as a PayPal
	// invoice for merchant visibility and refund attribution.
	await recordPaypalInvoice({
		customer: cust,
		externalId: paypalSaleInvoiceId(saleId),
		amountUsd: amount,
		productId: planProductId,
		description: "PayPal subscription cycle",
	});

	// The MeterPal plan behind the subscription carries the monthly allowance
	// and resets it every cycle, so granting the sale amount on top would
	// credit the customer twice per cycle.  The wallet grant stays the
	// fallback for subscriptions with no MeterPal plan behind them.
	if (
		await hasActiveMeterPalPlan({ customer: cust, productId: planProductId })
	) {
		logger.info({
			msg: "paypal: sale cycle already covered by the meter's plan allowance",
			subscriptionId,
			customerId: cust.id,
			productId: planProductId,
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
	const currency = (
		event.resource?.amount?.currency_code ?? "USD"
	).toUpperCase();
	if (currency !== "USD") {
		logger.warn({
			msg: "paypal refund: unsupported currency",
			refundId: event.resource?.id,
			currency,
		});
		return;
	}

	// Resolve through the ORIGINAL PAYMENT — the refund links to it, and the
	// payment's custom_id names the customer who was actually paid.  Email
	// is deliberately NOT consulted: it let a refund debit whichever
	// customer row happened to share an address (cross-tenant wallet drain).
	//
	// Captures (Orders v2) link "up"; sales (subscription cycles) carry
	// resource.sale_id.  Either names a ledger row we wrote when the money
	// landed, which is what the refund cap (never refund more than granted)
	// and the customer resolution read.
	let captureId: string | null = null;
	for (const link of event.resource?.links ?? []) {
		if (link.rel === "up" && typeof link.href === "string") {
			captureId = link.href.split("/").pop() ?? null;
			break;
		}
	}
	const saleId: string | null = event.resource?.sale_id ?? null;

	let cust: DbCustomer | null = null;
	let refundCap: number | null = null; // never refund more than was granted

	const readLedgerRow = async (
		idempotencyKey: string,
	): Promise<{ customer: DbCustomer; grantedUsd: number | null } | null> => {
		const [ledgerRow] = await db
			.select({
				customer_id: walletLedger.customer_id,
				amount_usd: walletLedger.amount_usd,
			})
			.from(walletLedger)
			.where(eq(walletLedger.idempotency_key, idempotencyKey))
			.limit(1);
		if (!ledgerRow) return null;
		const [row] = await db
			.select()
			.from(customers)
			.where(eq(customers.id, ledgerRow.customer_id))
			.limit(1);
		if (!row) return null;
		return { customer: row, grantedUsd: ledgerRow.amount_usd ?? null };
	};

	if (captureId) {
		const viaCapture = await readLedgerRow(`paypal-capture:${captureId}`);
		if (viaCapture) {
			cust = viaCapture.customer;
			refundCap = viaCapture.grantedUsd;
		}
	}
	if (!cust && saleId) {
		const viaSale = await readLedgerRow(`paypal-sale:${saleId}`);
		if (viaSale) {
			cust = viaSale.customer;
			refundCap = viaSale.grantedUsd;
		}
	}

	if (!cust) {
		// Fall back to the payer id from the refund event; never email.
		cust = await resolveCustomer({
			payerId: event.resource?.payer?.payer_id ?? null,
		});
	}
	if (!cust) {
		logger.warn({
			msg: "paypal refund: no customer for refund — skipping",
			refundId: event.resource?.id,
			captureId,
			saleId,
		});
		return;
	}

	const refundAmount = Math.min(
		Math.abs(amount),
		refundCap != null && refundCap > 0 ? refundCap : Math.abs(amount),
	);

	const grantApplied = await grantWalletCredits({
		customer: cust,
		amountUsd: -refundAmount,
		idempotencyKey: `paypal-refund:${event.resource?.id}`,
		eventName: "refund",
		metadata: {
			event_type: event.type,
			capture_id: captureId,
			sale_id: saleId,
		},
	});

	// Track the refund on the PayPal invoice row — but only when the wallet
	// correction actually applied, so the endpoint-initiated refund (whose
	// webhook still fires here) is never counted twice.
	if (grantApplied && captureId) {
		await incrementPaypalInvoiceRefund({
			externalId: paypalCaptureInvoiceId(captureId),
			amountUsd: refundAmount,
		});
	} else if (grantApplied && saleId) {
		await incrementPaypalInvoiceRefund({
			externalId: paypalSaleInvoiceId(saleId),
			amountUsd: refundAmount,
		});
	}
}

/**
 * Atomically adds to `invoices.refunded_amount` for a PayPal invoice row.
 * A no-op (with a warning) when the row is missing — refunds recorded
 * before invoice recording shipped have nothing to increment.
 */
export async function incrementPaypalInvoiceRefund({
	externalId,
	amountUsd,
}: {
	externalId: string;
	amountUsd: number;
}): Promise<void> {
	const updated = await db
		.update(invoices)
		.set({
			refunded_amount: sql`${invoices.refunded_amount} + ${amountUsd}`,
		})
		.where(eq(invoices.processor_invoice_id, externalId))
		.returning({ id: invoices.id });
	if (updated.length === 0) {
		logger.warn({
			msg: "paypal refund: no invoice row to track refunded_amount on",
			externalId,
			amountUsd,
		});
	}
}

async function onCaptureCompleted(
	event: PayPalEvent,
	client?: PaypalClient,
): Promise<void> {
	// A one-shot wallet top-up landed.  The capture webhook carries the order
	// id in supplementary_data.related_ids.order_id — fetch the order to read
	// the custom_id we stamped at checkout ("mp:<customer_id>:<product_id>").
	const capture = event.resource;
	const captureId = capture?.id;
	const amount = parseFloat(capture?.amount?.value ?? "0");
	const currency = (capture?.amount?.currency_code ?? "USD").toUpperCase();
	if (!captureId || !amount) return;
	if (currency !== "USD") {
		logger.warn({
			msg: "paypal capture: unsupported currency",
			captureId,
			currency,
		});
		return;
	}

	const orderId = capture?.supplementary_data?.related_ids?.order_id;
	let customId: string | null = capture?.custom_id ?? null;

	if (!customId && orderId) {
		// The per-org route hands us the client; the legacy route has no
		// org, so the order's own intent row names the account to ask.
		const orderClient = client ?? (await getPaypalClientForOrder(orderId));
		if (orderClient) {
			try {
				const order = await orderClient.fetch<{
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
	}

	let customCustomerId: string | undefined;
	let customProductId: string | undefined;
	if (customId?.startsWith("mp:")) {
		// "mp:<customer_id>:<product_id>" — stamped at checkout creation.
		customCustomerId = customId.split(":")[1];
		customProductId = customId.split(":")[2];
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
	await recordPaypalInvoice({
		customer: cust,
		externalId: paypalCaptureInvoiceId(captureId),
		amountUsd: amount,
		productId: customProductId,
		description: "PayPal credit pack",
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
	const invoiceCurrency = (
		invoice?.detail?.currency_code ??
		invoice?.amount?.currency_code ??
		"USD"
	).toUpperCase();
	if (!invoiceId || !amount) return;
	if (invoiceCurrency !== "USD") {
		// 1 credit = 1 USD — never credit a non-USD invoice 1:1.
		logger.warn({
			msg: "paypal invoice paid: unsupported currency",
			invoiceId,
			currency: invoiceCurrency,
		});
		return;
	}

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
	await recordPaypalInvoice({
		customer: cust,
		externalId: paypalInvoiceRefId(invoiceId),
		amountUsd: amount,
		description: "PayPal overage invoice",
	});
}

/**
 * Surfaces a PayPal dispute (chargeback, item-not-received claim) to the
 * merchant as a `billing.dispute_*` webhook.  No wallet movement here: the
 * funds reversal arrives separately as PAYMENT.CAPTURE.REVERSED (or
 * PAYMENT.SALE.REVERSED), which already applies the negative grant —
 * correcting twice would debit the wallet once per dispute stage.
 */
async function onDispute(event: PayPalEvent): Promise<void> {
	const dispute = event.resource;
	const disputeId = dispute?.dispute_id;
	if (!disputeId) return;

	const disputedTransactionId: string | undefined =
		dispute?.disputed_transaction?.transaction_id;

	// Resolve the affected customer through the disputed payment: the
	// transaction id is a capture or sale id — the same ledger keys the
	// money handlers wrote when the customer paid.
	let cust: DbCustomer | null = null;
	for (const key of [
		disputedTransactionId ? `paypal-capture:${disputedTransactionId}` : null,
		disputedTransactionId ? `paypal-sale:${disputedTransactionId}` : null,
	]) {
		if (!key) continue;
		const [ledgerRow] = await db
			.select({ customer_id: walletLedger.customer_id })
			.from(walletLedger)
			.where(eq(walletLedger.idempotency_key, key))
			.limit(1);
		if (ledgerRow) {
			const [row] = await db
				.select()
				.from(customers)
				.where(eq(customers.id, ledgerRow.customer_id))
				.limit(1);
			if (row) {
				cust = row;
				break;
			}
		}
	}
	if (!cust) {
		cust = await resolveCustomer({
			payerId: dispute?.payer?.payer_id ?? null,
		});
	}

	const eventType =
		event.type === "CUSTOMER.DISPUTE.CREATED"
			? WebhookEventType.BillingDisputeCreated
			: WebhookEventType.BillingDisputeUpdated;

	const payload = {
		dispute_id: disputeId,
		status: dispute?.status ?? null,
		reason: dispute?.reason ?? null,
		dispute_life_cycle_stage: dispute?.dispute_life_cycle_stage ?? null,
		amount: dispute?.dispute_amount?.value
			? parseFloat(dispute.dispute_amount.value)
			: null,
		currency: (dispute?.dispute_amount?.currency_code ?? "USD").toUpperCase(),
		disputed_transaction_id: disputedTransactionId ?? null,
		customer_id: cust?.id ?? null,
	};

	logger.warn({
		msg: "paypal: dispute received",
		...payload,
		eventType: event.type,
	});

	if (!cust?.id) {
		logger.warn({
			msg: "paypal dispute: no customer for dispute — webhook not sent",
			disputeId,
		});
		return;
	}

	const ctx = await createWorkerContext({
		db,
		payload: {
			orgId: cust.org_id,
			env: cust.env as AppEnv,
			customerId: cust.id,
			requestId: `paypal-dispute:${disputeId}:${event.type}`,
		},
		logger,
	});
	if (!ctx) return;

	try {
		await sendSvixEvent({
			ctx,
			eventType,
			payloadFields: {
				id: `evt_paypal_dispute_${disputeId}`,
				occurred_at: Date.now(),
			},
			data: payload,
			idempotencyKey: `paypal-dispute:${disputeId}:${event.type}`,
		});
	} catch (err) {
		logger.error({
			msg: "paypal dispute: merchant webhook failed",
			disputeId,
			error: String(err),
		});
	}
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
