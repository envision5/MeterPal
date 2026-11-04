import {
	type BillingPlan,
	type BillingResult,
	ErrCode,
	type MultiUpdateParamsV0,
	type MultiUpdatePreviewResponseV0,
	RecaseError,
	type UpdateSubscriptionBillingContext,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { executeBillingPlan } from "@/internal/billing/v2/execute/executeBillingPlan";
import { setupFullCustomerContext } from "@/internal/billing/v2/setup/setupFullCustomerContext";
import { logAutumnBillingPlan } from "@/internal/billing/v2/utils/logs/logAutumnBillingPlan";
import { computeMultiUpdateFold } from "./compute/computeMultiUpdateFold";
import { handleMultiUpdateErrors } from "./errors/handleMultiUpdateErrors";
import { buildMultiUpdatePreviewResponse } from "./preview/buildMultiUpdatePreviewResponse";

export type MultiUpdateResult = {
	billingContext: UpdateSubscriptionBillingContext;
	billingPlan: BillingPlan;
	billingResult?: BillingResult;
	previewResponse?: MultiUpdatePreviewResponseV0;
};

export async function multiUpdate({
	ctx,
	params,
	preview = false,
}: {
	ctx: AutumnContext;
	params: MultiUpdateParamsV0;
	preview?: boolean;
}): Promise<MultiUpdateResult> {
	ctx.logger.info(
		`=============== RUNNING MULTI UPDATE FOR ${params.customer_id} ===============`,
	);

	// 1. Setup: one customer load; per-item contexts are built inside the fold
	const fullCustomer = await setupFullCustomerContext({
		ctx,
		params: { customer_id: params.customer_id },
	});

	// 2. Compute: fold every update onto one AutumnBillingPlan
	const { autumnBillingPlan, itemResults } = await computeMultiUpdateFold({
		ctx,
		params,
		fullCustomer,
		preview,
	});

	const primaryBillingContext = itemResults[0].billingContext;

	logAutumnBillingPlan({
		ctx,
		plan: autumnBillingPlan,
		billingContext: primaryBillingContext,
	});

	// 3. Errors — per item, before any execution
	await handleMultiUpdateErrors({ ctx, itemResults });

	const billingPlan: BillingPlan = { autumn: autumnBillingPlan };

	if (preview) {
		const previewResponse = await buildMultiUpdatePreviewResponse({
			ctx,
			customerId: params.customer_id,
			itemResults,
		});
		return {
			billingContext: primaryBillingContext,
			billingPlan,
			billingResult: undefined,
			previewResponse,
		};
	}

	// Cancels never require checkout; reject any item whose setup decided
	// payment collection is needed rather than executing without it
	const checkoutItem = itemResults.find(
		(itemResult) => itemResult.billingContext.checkoutMode !== null,
	);
	if (checkoutItem) {
		throw new RecaseError({
			code: ErrCode.InvalidRequest,
			statusCode: 400,
			message: `Multi update does not support updates that require checkout (plan: ${checkoutItem.billingContext.customerProduct.product.id})`,
		});
	}

	// 4. Execute (DB-only — multiUpdate never creates processor checkouts)
	const billingResult = await executeBillingPlan({
		ctx,
		billingContext: primaryBillingContext,
		billingPlan,
	});

	return {
		billingContext: primaryBillingContext,
		billingPlan,
		billingResult,
	};
}
