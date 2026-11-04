import {
	AffectedResource,
	ApiVersion,
	InternalError,
	UpdateSubscriptionV0ParamsSchema,
	UpdateSubscriptionV1ParamsSchema,
	Scopes,
	UpdateSubscriptionPreviewIntent,
} from "@autumn/shared";
import { billingActions } from "@/internal/billing/v2/actions";
import { resolvePaypalCancelActionTarget } from "@/internal/billing/paypal/paypalSubscriptionLifecycle.js";
import { billingPlanToUpdateSubscriptionPreview } from "@/internal/billing/v2/utils/billingPlan/toUpdateSubscriptionPreview/billingPlanToUpdateSubscriptionPreview";
import { createRoute } from "../../../../honoMiddlewares/routeHandler";

export const handlePreviewUpdateSubscription = createRoute({
	scopes: [Scopes.Billing.Read],
	versionedBody: {
		latest: UpdateSubscriptionV1ParamsSchema,
		[ApiVersion.V1_Beta]: UpdateSubscriptionV0ParamsSchema,
	},
	resource: AffectedResource.ApiSubscriptionUpdate,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const body = c.req.valid("json");

		// PayPal-billed customers: the v2 preview runs the processor pipeline, so
		// cancels / uncancels get a zero-charge preview here instead.  PayPal
		// cancels stop future charges immediately and never prorate, and a
		// reactivation charges nothing.
		if (body.cancel_action) {
			const paypalCustomer = await resolvePaypalCancelActionTarget({
				ctx,
				customerId: body.customer_id,
				planId: body.plan_id,
			});
			if (paypalCustomer) {
				const intent =
					body.cancel_action === "uncancel"
						? UpdateSubscriptionPreviewIntent.Uncancel
						: UpdateSubscriptionPreviewIntent.CancelImmediately;
				return c.json(
					{
						object: "update_subscription_preview",
						customer_id: paypalCustomer.id ?? paypalCustomer.internal_id,
						line_items: [],
						subtotal: 0,
						total: 0,
						currency: ctx.org.default_currency ?? "usd",
						intent,
					},
					200,
				);
			}
		}

		const { billingContext, billingPlan } =
			await billingActions.updateSubscription({
				ctx,
				params: body,
				preview: true,
			});

		if (!billingPlan) {
			throw new InternalError({
				message: "billingPlan not returned from updateSubscription preview",
			});
		}

		// 7. Format response
		const previewResponse = await billingPlanToUpdateSubscriptionPreview({
			ctx,
			billingContext,
			billingPlan,
		});

		return c.json(previewResponse, 200);
	},
});
