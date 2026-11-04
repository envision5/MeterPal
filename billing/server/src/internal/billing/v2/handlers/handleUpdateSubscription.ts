import {
	AffectedResource,
	ApiVersion,
	type BillingContext,
	InternalError,
	Scopes,
	UpdateSubscriptionV0ParamsSchema,
	UpdateSubscriptionV1ParamsSchema,
} from "@autumn/shared";
import { billingActions } from "@/internal/billing/v2/actions";
import { updatePendingPlanIfAny } from "@/internal/billing/v2/execute/pendingCustomerProducts/updatePendingPlanIfAny";
import { buildBillingLockKey } from "@/internal/billing/v2/utils/billingLock/buildBillingLockKey";
import { handlePaypalSubscriptionCancelAction } from "@/internal/billing/paypal/paypalSubscriptionLifecycle.js";
import { createRoute } from "../../../../honoMiddlewares/routeHandler";
import { billingResultToResponse } from "../utils/billingResult/billingResultToResponse";

export const handleUpdateSubscription = createRoute({
	scopes: [Scopes.Billing.Write],
	versionedBody: {
		latest: UpdateSubscriptionV1ParamsSchema,
		[ApiVersion.V1_Beta]: UpdateSubscriptionV0ParamsSchema,
	},
	resource: AffectedResource.ApiSubscriptionUpdate,
	lock:
		process.env.NODE_ENV !== "development"
			? {
					ttlMs: 120000,
					errorMessage:
						"Update subscription already in progress for this customer, try again in a few seconds",
					getKey: (c) => {
						const ctx = c.get("ctx");
						const attachBody = c.req.valid("json");
						return buildBillingLockKey({
							orgId: ctx.org.id,
							env: ctx.env,
							customerId: attachBody.customer_id,
						});
					},
				}
			: undefined,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const body = c.req.valid("json");

		// PayPal-billed customers: cancel / uncancel run through the PayPal
		// subscriptions API (the v2 pipeline drives the processor).  Plan changes
		// without a cancel_action still use the pipeline below.
		if (body.cancel_action) {
			const paypal = await handlePaypalSubscriptionCancelAction({
				ctx,
				customerId: body.customer_id,
				planId: body.plan_id,
				cancelAction: body.cancel_action,
			});
			if (paypal.handled && paypal.customer) {
				// The mapper only reads the customer identity off the context —
				// the PayPal cancel carries no processor invoice or checkout URL.
				return c.json(
					billingResultToResponse({
						billingContext: {
							fullCustomer: paypal.customer,
						} as unknown as BillingContext,
						billingResult: { processor: {} },
					}),
					200,
				);
			}
		}

		const pendingUpdate = await updatePendingPlanIfAny({ ctx, params: body });

		if (pendingUpdate) {
			const { billingContext, billingResult } = pendingUpdate;
			if (!billingContext || !billingResult) {
				return c.json({ success: true }, 200);
			}

			return c.json(
				billingResultToResponse({ billingContext, billingResult }),
				200,
			);
		}

		const { billingContext, billingResult } =
			await billingActions.updateSubscription({
				ctx,
				params: body,
				preview: false,
			});

		if (!billingResult) {
			throw new InternalError({
				message: "billingResult not returned from updateSubscription action",
			});
		}

		const response = billingResultToResponse({
			billingContext,
			billingResult,
		});

		return c.json(response, 200);
	},
});
