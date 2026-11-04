import type { Checkout } from "@autumn/shared";
import {
	type AttachBillingContext,
	type AttachParamsV1,
	type BillingResponse,
	type BillingResult,
	CheckoutAction,
	CheckoutStatus,
	type ConfirmCheckoutResponse,
	ErrCode,
	InternalError,
	RecaseError,
	type UpdateSubscriptionBillingContext,
	type UpdateSubscriptionV1Params,
} from "@autumn/shared";
import { StatusCodes } from "http-status-codes";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { billingActions } from "@/internal/billing/v2/actions";
import { billingResultToResponse } from "@/internal/billing/v2/utils/billingResult/billingResultToResponse";
import { invalidateCachedFullSubject } from "@/internal/customers/cache/fullSubject/index.js";
import { orgToReturnUrl } from "@autumn/shared";
import { updateCheckoutDbAndCache } from "./updateDbAndCache";

const buildConfirmCheckoutResponse = ({
	checkout,
	productId,
	invoiceId,
	response,
	successUrl,
}: {
	checkout: Checkout;
	productId: string;
	invoiceId: string | null;
	response: BillingResponse;
	successUrl: string;
}): ConfirmCheckoutResponse => ({
	...response,
	success: !response.required_action,
	checkout_id: checkout.id,
	product_id: productId,
	invoice_id: invoiceId,
	success_url: successUrl,
});

export const confirmCheckout = async ({
	ctx,
	checkout,
	params,
}: {
	ctx: AutumnContext;
	checkout: Checkout;
	params: AttachParamsV1 | UpdateSubscriptionV1Params;
}): Promise<ConfirmCheckoutResponse> => {
	if (checkout.status === CheckoutStatus.ActionRequired) {
		throw new RecaseError({
			message: "Checkout requires payment completion",
			code: ErrCode.InvalidRequest,
			statusCode: StatusCodes.BAD_REQUEST,
		});
	}

	if (checkout.status !== CheckoutStatus.Pending) {
		throw new RecaseError({
			message: "Checkout is not pending",
			code: ErrCode.InvalidRequest,
			statusCode: StatusCodes.BAD_REQUEST,
		});
	}

	let billingContext:
		| AttachBillingContext
		| UpdateSubscriptionBillingContext
		| undefined;
	let billingResult: BillingResult | undefined;
	let response: BillingResponse | undefined;
	let successUrl: string | undefined;
	let productId: string;

	switch (checkout.action) {
		case CheckoutAction.Attach: {
			const checkoutResult = await billingActions.attach({
				ctx,
				params: params as AttachParamsV1,
				preview: false,
				skipAutumnCheckout: true,
			});

			billingContext = checkoutResult.billingContext;
			billingResult = checkoutResult.billingResult;
			productId = checkoutResult.billingContext.attachProduct.id;
			break;
		}
		case CheckoutAction.UpdateSubscription: {
			const checkoutResult = await billingActions.updateSubscription({
				ctx,
				params: params as UpdateSubscriptionV1Params,
				preview: false,
				options: {
					skipAutumnCheckout: true,
				},
			});

			billingContext = checkoutResult.billingContext;
			billingResult = checkoutResult.billingResult;
			productId = checkoutResult.billingContext.customerProduct.product.id;
			break;
		}
		default:
			throw new RecaseError({
				message: "Unsupported checkout action",
				code: ErrCode.InvalidRequest,
				statusCode: StatusCodes.BAD_REQUEST,
			});
	}

	if (!response && !billingResult) {
		throw new InternalError({
			message: "Checkout confirmation did not return a billing response",
		});
	}

	let confirmedResponse: BillingResponse;
	if (response) {
		confirmedResponse = response;
	} else {
		if (!billingContext || !billingResult) {
			throw new InternalError({
				message: "Checkout confirmation is missing billing context",
			});
		}

		confirmedResponse = billingResultToResponse({
			billingContext,
			billingResult,
		});
	}
	const invoiceId =
		billingResult?.processor?.autumnInvoice?.id ??
		confirmedResponse.invoice?.processor_invoice_id ??
		null;
	const confirmedSuccessUrl =
		successUrl ??
		billingContext?.successUrl ??
		orgToReturnUrl({ org: ctx.org, env: ctx.env });

	const newCheckoutStatus = confirmedResponse.required_action
		? CheckoutStatus.ActionRequired
		: CheckoutStatus.Completed;

	await updateCheckoutDbAndCache({
		ctx,
		oldCheckout: checkout,
		updates: {
			status: newCheckoutStatus,
			response: confirmedResponse,
			completed_at:
				newCheckoutStatus === CheckoutStatus.Completed ? Date.now() : null,
		},
	});

	if (
		newCheckoutStatus === CheckoutStatus.Completed &&
		billingResult?.processor?.deferred !== true &&
		!ctx.skipSubjectCacheDeletion
	) {
		await invalidateCachedFullSubject({
			ctx,
			customerId: checkout.customer_id,
			entityId: "entity_id" in params ? params.entity_id : undefined,
			source: "confirmCheckout",
		});
	}

	return buildConfirmCheckoutResponse({
		checkout,
		productId,
		invoiceId,
		response: confirmedResponse,
		successUrl: confirmedSuccessUrl,
	});
};
