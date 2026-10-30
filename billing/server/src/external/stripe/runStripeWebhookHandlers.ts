import { handleStripeInvoicePaid } from "@/external/stripe/webhookHandlers/handleStripeInvoicePaid/handleStripeInvoicePaid.js";
import { handleStripeSubscriptionUpdated } from "@/external/stripe/webhookHandlers/handleStripeSubscriptionUpdated/handleStripeSubscriptionUpdated.js";
import { handleCusDiscountDeleted } from "./webhookHandlers/handleCusDiscountDeleted.js";
import { handleInvoiceUpdated } from "./webhookHandlers/handleInvoiceUpdated.js";
import { handleStripeApplicationDeauthorized } from "./webhookHandlers/handleStripeApplicationDeauthorized.js";
import { handleStripeCheckoutSessionCompleted } from "./webhookHandlers/handleStripeCheckoutSessionCompleted/handleStripeCheckoutSessionCompleted.js";
import { handleStripeCheckoutSessionExpired } from "./webhookHandlers/handleStripeCheckoutSessionExpired/handleStripeCheckoutSessionExpired.js";
import { handleStripeCustomerUpdated } from "./webhookHandlers/handleStripeCustomerUpdated.js";
import { handleStripeInvoiceCreated } from "./webhookHandlers/handleStripeInvoiceCreated/handleStripeInvoiceCreated.js";
import { handleStripeInvoiceFinalized } from "./webhookHandlers/handleStripeInvoiceFinalized/handleStripeInvoiceFinalized.js";
import { handleStripeSubscriptionCreated } from "./webhookHandlers/handleStripeSubscriptionCreated/handleStripeSubscriptionCreated.js";
import { handleStripeSubscriptionDeleted } from "./webhookHandlers/handleStripeSubscriptionDeleted/handleStripeSubscriptionDeleted.js";
import { handleStripeSubscriptionScheduleReleased } from "./webhookHandlers/handleStripeSubscriptionScheduleReleased/handleStripeSubscriptionScheduleReleased.js";
import { handleStripeSubscriptionScheduleUpdated } from "./webhookHandlers/handleStripeSubscriptionScheduleUpdated/handleStripeSubscriptionScheduleUpdated.js";
import { handleStripeTestClockReady } from "./webhookHandlers/handleStripeTestClockReady.js";
import { handleSubscriptionScheduleCanceled } from "./webhookHandlers/handleSubScheduleCanceled.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { customers } from "@autumn/shared";
import { logger } from "@/external/logtail/logtailUtils.js";
import type Stripe from "stripe";
import type { StripeWebhookContext } from "./webhookMiddlewares/stripeWebhookContext.js";

/**
 * Dispatches a Stripe event to its handler. Shared by the webhook route and
 * the SQS replay worker — errors propagate to the caller.
 */
export const runStripeWebhookHandlers = async ({
	ctx,
}: {
	ctx: StripeWebhookContext;
}) => {
	const { db, org, env, stripeEvent } = ctx;
	const event = stripeEvent;

	// await throwOnSimulatedWebhookFailure({ ctx });

	switch (event.type) {
		case "account.application.deauthorized":
			await handleStripeApplicationDeauthorized({ ctx });
			break;

		case "customer.updated":
			await handleStripeCustomerUpdated({ ctx, event });
			break;

		case "customer.subscription.created":
			await handleStripeSubscriptionCreated({ ctx });
			await notifyLitellmSubscriptionActive({ ctx, event });
			break;

		case "customer.subscription.updated":
			await handleStripeSubscriptionUpdated({ ctx, event });
			await notifyLitellmSubscriptionActive({ ctx, event });
			break;

		case "customer.subscription.deleted":
			await handleStripeSubscriptionDeleted({ ctx, event });
			await notifyLitellmSubscriptionCancelled({ ctx, event });
			break;

		case "invoice.paid":
			await handleStripeInvoicePaid({ ctx, event });
			break;

		case "invoice.updated":
			await handleInvoiceUpdated({
				ctx,
				event,
			});
			break;

		case "invoice.created":
			await handleStripeInvoiceCreated({ ctx, event });
			break;

		case "invoice.finalized": {
			await handleStripeInvoiceFinalized({ ctx, event });
			break;
		}

		case "subscription_schedule.updated": {
			await handleStripeSubscriptionScheduleUpdated({ ctx, event });
			break;
		}

		case "subscription_schedule.released": {
			await handleStripeSubscriptionScheduleReleased({ ctx, event });
			break;
		}

		case "subscription_schedule.canceled": {
			const canceledSchedule = event.data.object;
			await handleSubscriptionScheduleCanceled({
				db,
				org,
				env,
				schedule: canceledSchedule,
			});
			break;
		}

		case "customer.discount.deleted":
			await handleCusDiscountDeleted({ ctx });
			break;

		case "checkout.session.completed": {
			await handleStripeCheckoutSessionCompleted({ ctx, event });
			await notifyLitellmSubscriptionActive({ ctx, event });
			break;
		}

		case "checkout.session.expired": {
			await handleStripeCheckoutSessionExpired({ ctx, event });
			break;
		}

		case "test_helpers.test_clock.ready": {
			await handleStripeTestClockReady({ ctx, event });
			break;
		}

		default:
			break;
	}
};

// ─── LiteLLM bridge triggers ─────────────────────────────────────────────
// Fire after the subscription lifecycle handlers above. Never throw: a
// misconfigured bridge must not fail Stripe webhook processing.

async function resolveCustomerId(
	ctx: StripeWebhookContext,
	stripeCustomerId: string | undefined,
): Promise<string | null> {
	if (ctx.fullCustomer?.id) return ctx.fullCustomer.id;
	if (!stripeCustomerId) return null;
	const [row] = await ctx.db
		.select({ id: customers.id, internalId: customers.internalId })
		.from(customers)
		.where(
			and(
				eq(customers.orgId, ctx.org.id),
				eq(sql`${customers.processor} ->> 'id'`, stripeCustomerId),
			),
		)
		.orderBy(desc(customers.createdAt))
		.limit(1);
	return row?.id ?? row?.internalId ?? null;
}

async function notifyLitellmSubscriptionActive({
	ctx,
	event,
}: {
	ctx: StripeWebhookContext;
	event: Stripe.Event;
}): Promise<void> {
	try {
		const customerId = await resolveCustomerId(
			ctx,
			(event.data.object as any)?.customer,
		);
		if (!customerId) return;

		const { onSubscriptionActive } = await import(
			"@/internal/keys/litellmWebhookTriggers.js"
		);
		await onSubscriptionActive(ctx, {
			customer_id: customerId,
			plan_key: planKeyForEvent(event),
		});
	} catch (e) {
		logger.error({ msg: "litellm provisioning trigger failed", err: String(e) });
	}
}

async function notifyLitellmSubscriptionCancelled({
	ctx,
	event,
}: {
	ctx: StripeWebhookContext;
	event: Stripe.Event;
}): Promise<void> {
	try {
		const customerId = await resolveCustomerId(
			ctx,
			(event.data.object as any)?.customer,
		);
		if (!customerId) return;

		const { onSubscriptionCancelled } = await import(
			"@/internal/keys/litellmWebhookTriggers.js"
		);
		await onSubscriptionCancelled(ctx, {
			customer_id: customerId,
			reason: event.type,
		});
	} catch (e) {
		logger.error({ msg: "litellm block trigger failed", err: String(e) });
	}
}

function planKeyForEvent(event: Stripe.Event): string {
	// Same convention as the PayPal bridge (planKeyForPlanId): plan names
	// mentioning a tier map to the matching budget in litellmKeys.
	const obj = event.data.object as any;
	const candidates = [
		obj?.metadata?.plan_key,
		obj?.metadata?.plan,
		...(obj?.items?.data ?? []).map((item: any) => item?.price?.nickname),
	];
	const joined = candidates.filter(Boolean).join(" ").toLowerCase();
	if (joined.includes("ultra")) return "ultra";
	if (
		joined.includes("pro_plus") ||
		joined.includes("pro-plus") ||
		joined.includes("proplus")
	)
		return "pro_plus";
	if (joined.includes("pro")) return "pro";
	return "free";
}
