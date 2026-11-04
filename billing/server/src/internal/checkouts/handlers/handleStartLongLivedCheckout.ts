import {
	type AttachParamsV1,
	AffectedResource,
	CheckoutAction,
	type Checkout,
	ErrCode,
	InternalError,
	RecaseError,
	Scopes,
} from "@autumn/shared";
import { StatusCodes } from "http-status-codes";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { billingActions } from "@/internal/billing/v2/actions";
import { buildBillingLockKey } from "@/internal/billing/v2/utils/billingLock/buildBillingLockKey";
import { billingResultToResponse } from "@/internal/billing/v2/utils/billingResult/billingResultToResponse";
import { checkoutActions } from "../actions";

const isLongLivedAttachCheckout = (checkout: Checkout) =>
	checkout.action === CheckoutAction.Attach &&
	"long_lived_checkout" in checkout.params &&
	checkout.params.long_lived_checkout === true;

export const handleStartLongLivedCheckout = createRoute({
	scopes: [Scopes.Public],
	resource: AffectedResource.Attach,
	lock:
		process.env.NODE_ENV !== "development"
			? {
					ttlMs: 120000,
					errorMessage:
						"Checkout start already in progress for this customer, try again in a few seconds",
					getKey: (c) => {
						const ctx = c.get("ctx");
						const checkout = c.get("checkout") as Checkout;
						return buildBillingLockKey({
							orgId: ctx.org.id,
							env: ctx.env,
							customerId: checkout.customer_id,
						});
					},
				}
			: undefined,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const checkout = c.get("checkout");

		if (!isLongLivedAttachCheckout(checkout)) {
			throw new RecaseError({
				message: "Long-lived checkout start only supports long-lived attach checkouts",
				code: ErrCode.InvalidRequest,
				statusCode: StatusCodes.BAD_REQUEST,
			});
		}

		const { billingContext, billingResult } = await billingActions.attach({
			ctx,
			params: {
				...(checkout.params as AttachParamsV1),
				long_lived_checkout: false,
			},
			preview: false,
			skipAutumnCheckout: true,
		});

		if (!billingResult) {
			throw new InternalError({
				message: "billingResult not returned from long-lived checkout attach",
			});
		}

		const response = billingResultToResponse({ billingContext, billingResult });
		if (!response.payment_url) {
			throw new InternalError({
				message: "Long-lived checkout attach did not return a payment URL",
			});
		}

		await checkoutActions.updateDbAndCache({
			ctx,
			oldCheckout: checkout,
			updates: { response },
		});

		return c.redirect(response.payment_url, StatusCodes.SEE_OTHER);
	},
});
