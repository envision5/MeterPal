// billing/server/src/internal/billing/paypal/paypalSubscriptionLifecycle.ts
//
// Merchant-initiated cancel / reactivate for PayPal subscriptions — the
// engine behind /v1/billing/cancel and /v1/billing.update (cancel_action
// uncancel) for customers billed through PayPal, mirroring what the billing
// portal's /portal/cancel route and the BILLING.SUBSCRIPTION.* webhooks do.
//
// PayPal semantics, straight from the Subscriptions v1 API:
//   - cancel stops all future charges immediately (no end-of-cycle option);
//     MeterPal ends the customer product right away to match the
//     BILLING.SUBSCRIPTION.CANCELLED webhook's behaviour.
//   - activate only reactivates a SUSPENDED subscription. A CANCELLED one is
//     dead at PayPal — the honest answer is a new subscription, so callers
//     get a 400 telling them so instead of a silent failure.

import {
	CusProductStatus,
	customers,
	type DbCustomer,
	paypalCatalogMap,
	products,
	RecaseError,
} from "@autumn/shared";
import { and, eq, or } from "drizzle-orm";
import { getPaypalClient } from "@/external/paypal/paypalClient.js";
import { activatePaypalSubscription } from "@/external/paypal/runPaypalWebhookHandlers.js";
import {
	activateSubscription,
	cancelSubscription,
	getSubscription,
	type PayPalSubscription,
} from "@/external/paypal/subscriptions.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { CusProductService } from "@/internal/customers/cusProducts/CusProductService.js";

export async function getPaypalCustomer({
	ctx,
	customerId,
}: {
	ctx: AutumnContext;
	customerId: string;
}): Promise<DbCustomer> {
	// Raw row on purpose: the PayPal columns (subscription id, billing
	// agreement) are customers-table columns the slim API Customer drops.
	const [customer] = await ctx.db
		.select()
		.from(customers)
		.where(
			and(
				eq(customers.org_id, ctx.org.id),
				eq(customers.env, ctx.env),
				or(eq(customers.id, customerId), eq(customers.internal_id, customerId)),
			),
		)
		.limit(1);
	if (!customer) {
		throw new RecaseError({
			message: `Customer ${customerId} not found`,
			statusCode: 404,
		});
	}
	return customer;
}

/** The ACTIVE customer product behind the subscription's PayPal plan, if any. */
async function findMappedCustomerProduct({
	ctx,
	customer,
}: {
	ctx: AutumnContext;
	customer: DbCustomer;
}) {
	const [mapRow] = customer.paypal_plan_id
		? await ctx.db
				.select({ productId: paypalCatalogMap.product_id })
				.from(paypalCatalogMap)
				.where(eq(paypalCatalogMap.paypal_plan_id, customer.paypal_plan_id))
				.limit(1)
		: [];
	if (!mapRow?.productId) return null;

	const [productRow] = await ctx.db
		.select({ internalId: products.internal_id })
		.from(products)
		.where(
			and(
				eq(products.id, mapRow.productId),
				eq(products.org_id, ctx.org.id),
				eq(products.env, ctx.env),
			),
		)
		.limit(1);
	if (!productRow?.internalId) return null;

	const cusProducts = await CusProductService.list({
		db: ctx.db,
		internalCustomerId: customer.internal_id,
		inStatuses: [CusProductStatus.Active],
	});
	return (
		cusProducts.find(
			(cp) => cp.product?.internal_id === productRow.internalId,
		) ?? null
	);
}

/**
 * Cancels the customer's PayPal subscription at PayPal and ends the
 * MeterPal-side plan.  Idempotent: an already-cancelled customer returns
 * without calling PayPal.
 */
export async function cancelPaypalSubscription({
	ctx,
	customerId,
	reason = "Cancelled by merchant",
}: {
	ctx: AutumnContext;
	customerId: string;
	reason?: string;
}): Promise<{ status: "cancelled" | "already_cancelled" }> {
	const customer = await getPaypalCustomer({ ctx, customerId });

	if (!customer.paypal_subscription_id) {
		throw new RecaseError({
			message: "Customer has no PayPal subscription to cancel",
			statusCode: 400,
		});
	}
	// A repeat click (or a race with the BILLING.SUBSCRIPTION.CANCELLED
	// webhook, which records the same state) must not re-call PayPal.
	if (customer.paypal_payment_status === "cancelled") {
		return { status: "already_cancelled" };
	}

	const client = await getPaypalClient({ org: ctx.org, env: ctx.env });
	await cancelSubscription(client, customer.paypal_subscription_id, reason);

	await ctx.db
		.update(customers)
		.set({ paypal_payment_status: "cancelled" })
		.where(
			and(
				eq(customers.internal_id, customer.internal_id),
				eq(customers.paypal_subscription_id, customer.paypal_subscription_id),
			),
		);

	const mapped = await findMappedCustomerProduct({ ctx, customer });
	if (mapped) {
		await CusProductService.update({
			ctx,
			cusProductId: mapped.id,
			updates: {
				canceled: true,
				canceled_at: Date.now(),
				ended_at: Date.now(),
				status: CusProductStatus.Expired,
			},
		});
		ctx.logger.info("paypal: ended customer product on cancel", {
			customerId: customer.id,
			productId: mapped.product?.id,
		});
	}

	ctx.logger.info("paypal: subscription cancelled", {
		customerId: customer.id,
		subscriptionId: customer.paypal_subscription_id,
		reason,
	});
	return { status: "cancelled" };
}

/**
 * Reactivates the customer's PayPal subscription.  Only a SUSPENDED
 * subscription can come back — the MeterPal side is then re-stamped through
 * the idempotent activation path (plan attach + payment status), so this
 * works with or without the webhook tunnel.
 */
export async function reactivatePaypalSubscription({
	ctx,
	customerId,
	reason = "Reactivated by merchant",
}: {
	ctx: AutumnContext;
	customerId: string;
	reason?: string;
}): Promise<{ status: "reactivated" }> {
	const customer = await getPaypalCustomer({ ctx, customerId });

	if (!customer.paypal_subscription_id) {
		throw new RecaseError({
			message: "Customer has no PayPal subscription to reactivate",
			statusCode: 400,
		});
	}

	const client = await getPaypalClient({ org: ctx.org, env: ctx.env });
	let sub: PayPalSubscription;
	try {
		sub = await getSubscription(client, customer.paypal_subscription_id);
	} catch {
		throw new RecaseError({
			message:
				"The PayPal subscription no longer exists — start a new subscription instead",
			statusCode: 400,
		});
	}

	if (sub.status === "ACTIVE" || sub.status === "APPROVED") {
		// Already live at PayPal — just make sure MeterPal reflects it.
		await activatePaypalSubscription(sub);
		return { status: "reactivated" };
	}
	if (sub.status !== "SUSPENDED") {
		throw new RecaseError({
			message: `A ${sub.status} PayPal subscription cannot be reactivated — start a new subscription instead`,
			statusCode: 400,
		});
	}

	await activateSubscription(client, sub.id!, reason);

	// Stamp MeterPal-side state right away (idempotent; the
	// BILLING.SUBSCRIPTION.RE-ACTIVATED webhook replays into the same path).
	await activatePaypalSubscription({
		...sub,
		status: "ACTIVE",
	});

	ctx.logger.info("paypal: subscription reactivated", {
		customerId: customer.id,
		subscriptionId: sub.id,
	});
	return { status: "reactivated" };
}

/**
 * Shared seam for the cancel/uncancel API entrypoints (POST /v1/billing/cancel
 * and /v1/billing.update with a cancel_action).
 *
 * `resolvePaypalCancelActionTarget` only DECIDES — the preview endpoint calls
 * it to answer "would this be handled by PayPal?" without side effects.
 * `handlePaypalSubscriptionCancelAction` decides AND executes; anything that
 * isn't the PayPal subscription's own plan falls through to the regular
 * pipeline.
 */
export async function resolvePaypalCancelActionTarget({
	ctx,
	customerId,
	planId,
}: {
	ctx: AutumnContext;
	customerId: string;
	/** The plan the request names — must be the PayPal subscription's plan. */
	planId?: string | null;
}): Promise<DbCustomer | null> {
	// A customer the seam can't resolve is not a PayPal cancel — let the
	// regular pipeline surface whatever is wrong with the request.
	let customer: DbCustomer;
	try {
		customer = await getPaypalCustomer({ ctx, customerId });
	} catch {
		return null;
	}
	if (!customer?.paypal_subscription_id) return null;

	// Only the PayPal subscription's own plan is ours to cancel — a request
	// naming a different plan belongs to the regular pipeline.  Compared via
	// the catalog map directly: the customer product is already expired when
	// uncancelling, so it can't be the lookup path.
	if (planId && customer.paypal_plan_id) {
		const [mapRow] = await ctx.db
			.select({ productId: paypalCatalogMap.product_id })
			.from(paypalCatalogMap)
			.where(eq(paypalCatalogMap.paypal_plan_id, customer.paypal_plan_id))
			.limit(1);
		if (mapRow?.productId && mapRow.productId !== planId) {
			return null;
		}
	}
	return customer;
}

export async function handlePaypalSubscriptionCancelAction({
	ctx,
	customerId,
	planId,
	cancelAction,
}: {
	ctx: AutumnContext;
	customerId: string;
	planId?: string | null;
	cancelAction: "cancel_immediately" | "cancel_end_of_cycle" | "uncancel";
}): Promise<{ handled: boolean; customer?: DbCustomer }> {
	const customer = await resolvePaypalCancelActionTarget({
		ctx,
		customerId,
		planId,
	});
	if (!customer) return { handled: false };

	if (cancelAction === "uncancel") {
		await reactivatePaypalSubscription({ ctx, customerId });
	} else {
		// PayPal has no end-of-cycle cancel — both actions stop future
		// charges immediately, so the two map to the same call.
		await cancelPaypalSubscription({ ctx, customerId });
	}
	return { handled: true, customer };
}
