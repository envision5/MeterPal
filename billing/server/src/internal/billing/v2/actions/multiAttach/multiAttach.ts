import type {
	BillingPlan,
	BillingResult,
	MultiAttachBillingContext,
	MultiAttachParamsV0,
} from "@autumn/shared";
import { checkoutSessionLock } from "@/external/redis/actions/checkoutSessionLock/checkoutSessionLock.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { checkCheckoutSessionLock } from "@/internal/billing/v2/actions/locks/checkoutSessionLock/checkCheckoutSessionLock";
import { executeBillingPlan } from "@/internal/billing/v2/execute/executeBillingPlan";
import { computeAttachPreviewBillingPlan } from "@/internal/billing/v2/utils/billingPlan/preview/computeAttachPreviewBillingPlan";
import { logAutumnBillingPlan } from "@/internal/billing/v2/utils/logs/logAutumnBillingPlan";
import { hashJson } from "@/utils/hash/hashJson";
import { computeMultiAttachPlan } from "./compute/computeMultiAttachPlan";
import { handleMultiAttachCurrencyErrors } from "./errors/handleMultiAttachCurrencyErrors";
import {
	handleMultiAttachBillingPlanErrors,
	handleMultiAttachErrors,
} from "./errors/handleMultiAttachErrors";
import { handleMultiAttachBackdateCheckoutError } from "./errors/handleMultiAttachStartDateErrors";
import { logMultiAttachContext } from "./logs/logMultiAttachContext";
import { setupMultiAttachBillingContext } from "./setup/setupMultiAttachBillingContext";

export interface MultiAttachResult {
	billingContext: MultiAttachBillingContext;
	billingPlan?: BillingPlan;
	billingResult?: BillingResult;
}

export async function multiAttach({
	ctx,
	params,
	preview = false,
}: {
	ctx: AutumnContext;
	params: MultiAttachParamsV0;
	preview?: boolean;
}): Promise<MultiAttachResult> {
	const checkoutReservation = !preview
		? await checkoutSessionLock.get({ ctx, customerId: params.customer_id })
		: undefined;

	// 1. Setup
	const billingContext = await setupMultiAttachBillingContext({
		ctx,
		params,
		preview,
	});

	// 2. Errors
	await handleMultiAttachErrors({
		ctx,
		billingContext,
		redirectMode: params.redirect_mode,
		params,
	});

	handleMultiAttachCurrencyErrors({ ctx, billingContext, params });

	// 2b. Log context
	logMultiAttachContext({ ctx, billingContext });

	// 3. Compute
	const autumnBillingPlan = computeMultiAttachPlan({
		ctx,
		multiAttachBillingContext: billingContext,
	});

	logAutumnBillingPlan({ ctx, plan: autumnBillingPlan, billingContext });

	const billingPlan: BillingPlan = { autumn: autumnBillingPlan };

	handleMultiAttachBillingPlanErrors({ ctx, billingContext, billingPlan });
	handleMultiAttachBackdateCheckoutError({ billingContext, params });

	if (preview) {
		const previewBillingPlan = await computeAttachPreviewBillingPlan({
			ctx,
			billingContext,
			autumnBillingPlan,
		});
		return {
			billingContext,
			billingPlan: { ...billingPlan, preview: previewBillingPlan },
		};
	}

	const cachedResult = await checkCheckoutSessionLock({
		ctx,
		params,
		billingContext,
		billingPlan,
		existingLock: checkoutReservation,
	});
	if (cachedResult) return cachedResult;

	// 4. Execute billing plan
	const billingResult = await executeBillingPlan({
		ctx,
		billingContext,
		billingPlan,
		checkoutLockParamsHash: hashJson({ value: params }),
	});

	return {
		billingContext,
		billingPlan,
		billingResult,
	};
}
