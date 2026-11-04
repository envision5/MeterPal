import type { UpdateSubscriptionV1Params } from "@autumn/shared";
import { Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import { handlePaypalSubscriptionCancelAction } from "@/internal/billing/paypal/paypalSubscriptionLifecycle.js";
import { computeUpdateSubscriptionPlan } from "@/internal/billing/v2/actions/updateSubscription/compute/computeUpdateSubscriptionPlan";
import { handleUpdateSubscriptionErrors } from "@/internal/billing/v2/actions/updateSubscription/errors/handleUpdateSubscriptionErrors";
import { logUpdateSubscriptionContext } from "@/internal/billing/v2/actions/updateSubscription/logs/logUpdateSubscriptionContext";
import { setupUpdateSubscriptionBillingContext } from "@/internal/billing/v2/actions/updateSubscription/setup/setupUpdateSubscriptionBillingContext";
import { executeBillingPlan } from "@/internal/billing/v2/execute/executeBillingPlan";
import { discardPendingPlanIfAny } from "@/internal/billing/v2/execute/pendingCustomerProducts/discardPendingPlanIfAny";
import { buildBillingLockKey } from "@/internal/billing/v2/utils/billingLock/buildBillingLockKey";
import { logAutumnBillingPlan } from "@/internal/billing/v2/utils/logs/logAutumnBillingPlan";

export const handleCancelV2 = createRoute({
	scopes: [Scopes.Billing.Write],
	lock:
		process.env.NODE_ENV !== "development"
			? {
					ttlMs: 120000,
					errorMessage:
						"Cancel already in progress for this customer, try again in a few seconds",
					getKey: (c) => {
						const ctx = c.get("ctx");
						if (!ctx.customerId) return null;
						return buildBillingLockKey({
							orgId: ctx.org.id,
							env: ctx.env,
							customerId: ctx.customerId,
						});
					},
				}
			: undefined,
	handler: async (c) => {
		const ctx = c.get("ctx");

		const {
			customer_id,
			product_id,
			entity_id,
			cancel_immediately = false,
			prorate: bodyProrate = true,
		} = await c.req.json();

		const updateSubscriptionBody: UpdateSubscriptionV1Params = {
			customer_id,
			plan_id: product_id,
			entity_id,
			cancel_action: cancel_immediately
				? "cancel_immediately"
				: "cancel_end_of_cycle",
			proration_behavior: bodyProrate ? "prorate_immediately" : "none",
			redirect_mode: "if_required",
		};

		ctx.logger.info(
			`=============== RUNNING CANCEL FOR ${customer_id} ===============`,
		);

		// PayPal-billed customers: cancel through the PayPal subscriptions API
		// instead of the billing engine.
		const paypalCancel = await handlePaypalSubscriptionCancelAction({
			ctx,
			customerId: customer_id,
			planId: product_id,
			cancelAction: "cancel_immediately",
		});
		if (paypalCancel.handled) {
			return c.json({
				success: true,
				customer_id: customer_id,
				product_id: product_id,
			});
		}

		const discarded = await discardPendingPlanIfAny({
			ctx,
			customerId: customer_id,
			productId: product_id,
			entityId: entity_id,
		});

		if (discarded) return c.json({ success: true });

		const billingContext = await setupUpdateSubscriptionBillingContext({
			ctx,
			params: updateSubscriptionBody,
		});
		logUpdateSubscriptionContext({ ctx, billingContext });

		const autumnBillingPlan = await computeUpdateSubscriptionPlan({
			ctx,
			billingContext,
			params: updateSubscriptionBody,
		});
		logAutumnBillingPlan({ ctx, plan: autumnBillingPlan, billingContext });

		const billingPlan = {
			autumn: autumnBillingPlan,
		};

		await handleUpdateSubscriptionErrors({
			ctx,
			billingContext,
			billingPlan,
			params: updateSubscriptionBody,
		});

		await executeBillingPlan({
			ctx,
			billingContext,
			billingPlan,
		});

		return c.json({
			success: true,
			customer_id: customer_id,
			product_id: product_id,
		});
	},
});
