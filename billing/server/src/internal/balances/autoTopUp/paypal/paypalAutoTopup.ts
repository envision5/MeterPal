// billing/server/src/internal/balances/autoTopUp/paypal/paypalAutoTopup.ts
//
// The PayPal executor for auto top-ups — the merchant-initiated charge that
// completes the agent-credit loop: the agent runs out of credits, the
// deduction below threshold enqueues the job (triggerAutoTopUp.ts), and this
// charges the customer's vaulted PayPal billing agreement WITHOUT buyer
// presence, then credits the wallet.
//
// The instrument is customers.paypal_billing_agreement_id (a BA-... token the
// buyer approved with their subscription; stamped at activation in
// runPaypalWebhookHandlers.ts).  Charging it is an Orders v2 merchant-
// initiated transaction — payment_source.paypal.billing_agreement_id with a
// MERCHANT stored credential — captured server-side; there is no approval
// link and no redirect.
//
// Config, limits (windows + durable circuit breaker), and the success /
// failure merchant webhooks are the SAME machinery the Stripe executor uses
// (fullCustomerToAutoTopupObjects, preflightAutoTopupLimits,
// recordAutoTopupAttempt) — only the charge step differs.

import type { AutoTopup, DbCustomer, FullCustomer } from "@autumn/shared";
import {
	cusEntToCusPrice,
	customerPriceToBillingUnits,
	roundUsageToNearestBillingUnit,
} from "@autumn/shared";
import {
	paypalCaptureInvoiceId,
	recordPaypalInvoice,
} from "@/external/paypal/invoiceRecording.js";
import type { OrderCreateArgs } from "@/external/paypal/orders.js";
import { captureOrder, createOrder } from "@/external/paypal/orders.js";
import { getPaypalClient } from "@/external/paypal/paypalClient.js";
import { grantWalletCredits } from "@/external/paypal/runPaypalWebhookHandlers.js";
import { toUsd } from "@/external/paypal/subscriptions.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { getBillableFullCustomer } from "@/internal/balances/getBillableFullCustomer.js";
import type { AutoTopUpPayload } from "@/queue/workflows.js";
import type { AutoTopupAttemptContext } from "../autoTopupContext.js";
import { fullCustomerToAutoTopupObjects } from "../helpers/fullCustomerToAutoTopupObjects.js";
import {
	preflightAutoTopupLimits,
	recordAutoTopupAttempt,
} from "../helpers/limits/index.js";
import { sendAutoTopupFailedWebhook } from "../webhooks/sendAutoTopupFailedWebhook.js";
import { sendAutoTopupSucceededWebhook } from "../webhooks/sendAutoTopupSucceededWebhook.js";

/**
 * True when this customer's charging instrument is a PayPal billing
 * agreement: vaulted BA token present and no Stripe customer — the Stripe
 * executor has nothing to run against.
 */
export const isPaypalChargedCustomer = ({
	fullCustomer,
}: {
	fullCustomer: {
		paypal_billing_agreement_id?: string | null;
		processor?: { id?: string } | null;
	};
}): boolean =>
	Boolean(fullCustomer.paypal_billing_agreement_id) &&
	!fullCustomer.processor?.id;

/** Fetch the full customer when it's charged via PayPal, else null. */
export const maybeGetPaypalAutoTopupCustomer = async ({
	ctx,
	customerId,
}: {
	ctx: AutumnContext;
	customerId: string;
}) => {
	const fullCustomer = await getBillableFullCustomer({
		ctx,
		customerId,
		source: "maybeGetPaypalAutoTopupCustomer",
	});
	if (fullCustomer && isPaypalChargedCustomer({ fullCustomer })) {
		return fullCustomer;
	}
	return null;
};

/**
 * The full-customer read is the raw customers row + joins, so the wallet
 * grant / invoice paths that need the row's own columns get it as one —
 * the row fields (paypal ids, env, org) are all present at runtime.
 */
const fullCustomerAsRow = (fullCustomer: FullCustomer): DbCustomer =>
	fullCustomer as unknown as DbCustomer;

/**
 * The merchant-initiated order for an auto top-up: charged against the
 * buyer's approved billing agreement, no approval link, marked as a
 * MERCHANT-initiated SUBSEQUENT charge for PayPal's risk engine.
 */
export const buildPaypalAutoTopupOrder = ({
	customerId,
	featureId,
	amountUsd,
	billingAgreementId,
}: {
	customerId: string;
	featureId: string;
	amountUsd: number;
	billingAgreementId: string;
}): OrderCreateArgs => ({
	intent: "CAPTURE",
	purchase_units: [
		{
			custom_id: `mp:${customerId}:${featureId}`,
			description: "MeterPal auto top-up",
			amount: {
				currency_code: "USD",
				value: toUsd(amountUsd),
				breakdown: {
					item_total: { currency_code: "USD", value: toUsd(amountUsd) },
				},
			},
		},
	],
	payment_source: {
		paypal: {
			billing_agreement_id: billingAgreementId,
			stored_credential: {
				payment_initiator: "MERCHANT",
				usage: "SUBSEQUENT",
			},
		},
	},
});

export const runPaypalAutoTopup = async ({
	ctx,
	payload,
	fullCustomer: preloadedCustomer,
}: {
	ctx: AutumnContext;
	payload: AutoTopUpPayload;
	/** Fetched by the job's PayPal branch to pick the executor — reuse it. */
	fullCustomer?: FullCustomer | null;
}): Promise<void> => {
	const { customerId, featureId } = payload;
	const { logger } = ctx;

	logger.info(
		`========= RUNNING PAYPAL AUTO TOPUP FOR CUSTOMER ${customerId} AND FEATURE ${featureId} ========`,
	);

	// 1. Customer + config (shared resolution — Stripe-agnostic).
	const fullCustomer = preloadedCustomer
		? preloadedCustomer
		: await maybeGetPaypalAutoTopupCustomer({ ctx, customerId });
	if (!fullCustomer) {
		logger.warn(
			`[runPaypalAutoTopup] Customer ${customerId} has no PayPal billing agreement, skipping`,
		);
		return;
	}

	const resolved = fullCustomerToAutoTopupObjects({
		fullCustomer,
		featureId,
	});
	if (!resolved?.balanceBelowThreshold) {
		// No enabled config, no chargeable entitlement, or balance recovered
		// before the job ran — the Stripe executor skips these silently too.
		logger.info(
			`[runPaypalAutoTopup] No enabled config or balance not below threshold for feature ${featureId}, skipping`,
		);
		return;
	}
	const { autoTopupConfig, customerEntitlement } = resolved;

	const sendFailureWebhook = (failure: {
		reason: Parameters<typeof sendAutoTopupFailedWebhook>[0]["reason"];
		message: string;
		suppressionKey?: string;
		suppressionTtlMs?: number;
		autoTopupContext?: AutoTopupAttemptContext;
	}) => sendAutoTopupFailedWebhook({ ctx, customerId, featureId, ...failure });

	// 2. Instrument — without a vaulted billing agreement there is nothing to
	// charge, so this surfaces as a missing payment method, the same failure
	// reason the Stripe executor reports.
	const billingAgreementId = fullCustomer.paypal_billing_agreement_id;
	if (!billingAgreementId) {
		await sendFailureWebhook({
			reason: "missing_payment_method",
			message: `Customer ${customerId} has no vaulted PayPal billing agreement for auto top-ups`,
		});
		return;
	}

	// 3. Normalize the top-up quantity to the feature's billing units, like
	// the Stripe setup does — the charge must match how credits are priced.
	const customerPrice = cusEntToCusPrice({
		cusEnt: customerEntitlement,
		errorOnNotFound: true,
	});
	const billingUnits = customerPriceToBillingUnits({ customerPrice });
	const quantity = roundUsageToNearestBillingUnit({
		usage: autoTopupConfig.quantity,
		billingUnits,
	});
	const normalizedConfig: AutoTopup = { ...autoTopupConfig, quantity };

	// 4. Limits: same windows + durable circuit breaker as the Stripe path.
	//    paymentMethod is null — PayPal declines carry no fingerprintable
	//    payment method, so the breaker tracks consecutive failures only.
	const preflight = await preflightAutoTopupLimits({
		ctx,
		payload,
		fullCustomer,
		autoTopupConfig: normalizedConfig,
		paymentMethod: null,
	});
	if (!preflight.allowed) {
		logger.info(
			`[runPaypalAutoTopup] Preflight blocked for feature ${featureId}, customer ${customerId}, reason: ${preflight.reason}`,
		);
		// Suspension has no window to expire — one webhook a day rather than
		// one per deduction, keyed off when the breaker tripped (same as the
		// Stripe setup's suppression keys).
		if (
			preflight.reason === "suspended_after_failures" &&
			preflight.limitState.suspended_at
		) {
			await sendFailureWebhook({
				reason: "suspended_after_failures",
				message: `PayPal auto top-ups suspended after consecutive failures for customer ${customerId}`,
				suppressionKey: [
					"auto_topup_failed_webhook",
					ctx.org.id,
					ctx.env,
					customerId,
					featureId,
					preflight.reason,
					preflight.limitState.suspended_at,
				].join(":"),
				suppressionTtlMs: 24 * 60 * 60 * 1000,
			});
		}
		return;
	}

	const attemptContext: AutoTopupAttemptContext = {
		fullCustomer,
		autoTopupConfig: normalizedConfig,
		customerEntitlement,
		limitState: preflight.limitState,
	};

	// 5. Charge the billing agreement — merchant-initiated Orders v2.  A
	// throw may still have reached PayPal, so the attempt is recorded before
	// rethrowing (the job-level catch classifies + notifies).
	try {
		const client = await getPaypalClient({ org: ctx.org, env: ctx.env });
		const order = await createOrder(
			client,
			buildPaypalAutoTopupOrder({
				customerId,
				featureId,
				amountUsd: quantity,
				billingAgreementId,
			}),
			{ idempotencyKey: `mp-autotopup-${crypto.randomUUID()}` },
		);

		const capture = (await captureOrder(client, order.id)) as Record<
			string,
			any
		>;
		await settlePaypalAutoTopupCapture({
			ctx,
			payload,
			attemptContext,
			orderId: order.id,
			capture,
		});
	} catch (error) {
		await recordAutoTopupAttempt({
			ctx,
			autoTopupContext: attemptContext,
			forceFailure: true,
		});
		throw error;
	}
};

/**
 * Applies a capture response to the wallet: grants the credits, records the
 * invoice, and closes the attempt out as success or failure.
 */
const settlePaypalAutoTopupCapture = async ({
	ctx,
	payload,
	attemptContext,
	orderId,
	capture,
}: {
	ctx: AutumnContext;
	payload: AutoTopUpPayload;
	attemptContext: AutoTopupAttemptContext;
	orderId: string;
	capture: Record<string, any>;
}): Promise<void> => {
	const { customerId, featureId } = payload;
	const { logger } = ctx;

	const captureResource = capture?.purchase_units?.[0]?.payments?.captures?.[0];
	const captureStatus = captureResource?.status;
	const captureId = captureResource?.id as string | undefined;

	if (captureStatus !== "COMPLETED" || !captureId) {
		// DECLINED → failure.  PENDING (e.g. an eCheck) counts as a failure
		// too: the wallet is not credited yet, and if PayPal later completes
		// it the PAYMENT.CAPTURE.COMPLETED webhook grants the credits through
		// the normal idempotent path.
		logger.warn({
			msg: "paypal auto topup: capture not completed",
			orderId,
			captureId: captureId ?? null,
			captureStatus: captureStatus ?? null,
			customerId,
		});
		await recordAutoTopupAttempt({
			ctx,
			autoTopupContext: attemptContext,
			forceFailure: true,
		});
		await sendAutoTopupFailedWebhook({
			ctx,
			customerId,
			featureId,
			reason: "charge_failed",
			message: `PayPal auto top-up capture status was ${captureStatus ?? "missing"}, expected COMPLETED`,
			autoTopupContext: attemptContext,
		});
		return;
	}

	const amount = parseFloat(captureResource.amount?.value ?? "0");
	const currency = (
		captureResource.amount?.currency_code ?? "USD"
	).toUpperCase();
	if (!amount || currency !== "USD") {
		// 1 credit = 1 USD — never credit a non-USD charge 1:1.
		logger.error({
			msg: "paypal auto topup: unsupported capture, crediting nothing",
			captureId,
			currency,
			amount,
		});
		await recordAutoTopupAttempt({
			ctx,
			autoTopupContext: attemptContext,
			forceFailure: true,
		});
		await sendAutoTopupFailedWebhook({
			ctx,
			customerId,
			featureId,
			reason: "charge_failed",
			message: `PayPal auto top-up capture was not a positive USD amount (${currency} ${amount})`,
			autoTopupContext: attemptContext,
		});
		return;
	}

	// 6. Credit the wallet (idempotent on the capture id — the
	// PAYMENT.CAPTURE.COMPLETED webhook for this charge replays into the same
	// grant) and record the payment as a PayPal invoice.
	const customerRow = fullCustomerAsRow(attemptContext.fullCustomer);
	await grantWalletCredits({
		customer: customerRow,
		amountUsd: amount,
		idempotencyKey: `paypal-capture:${captureId}`,
		eventName: "auto_topup",
		metadata: {
			capture_id: captureId,
			order_id: orderId,
			feature_id: featureId,
			via: "auto_topup",
		},
	});
	await recordPaypalInvoice({
		customer: customerRow,
		externalId: paypalCaptureInvoiceId(captureId),
		amountUsd: amount,
		description: "PayPal auto top-up",
	});

	await recordAutoTopupAttempt({
		ctx,
		autoTopupContext: attemptContext,
		overrideOutcome: "success",
	});
	await sendAutoTopupSucceededWebhook({
		ctx,
		autoTopupContext: attemptContext,
		billingResult: { stripe: {} },
	});

	logger.info({
		msg: "paypal auto topup: completed",
		customerId,
		featureId,
		captureId,
		amount,
	});
};
