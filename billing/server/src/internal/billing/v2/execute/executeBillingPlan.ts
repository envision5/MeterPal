import type {
	BillingContext,
	BillingPlan,
	BillingResult,
	ProcessorBillingResult,
} from "@autumn/shared";
import { checkoutSessionLock } from "@/external/redis/actions/checkoutSessionLock/checkoutSessionLock.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { executeAutumnBillingPlan } from "@/internal/billing/v2/execute/executeAutumnBillingPlan";
import { sendBillingUpdatedWebhook } from "@/internal/billing/v2/workflows/sendBillingUpdatedWebhook/sendBillingUpdatedWebhook";
import { billingPlanToSendProductsUpdated } from "@/internal/billing/v2/workflows/sendProductsUpdated/billingPlanToSendProductsUpdated";

/**
 * Executes a billing plan. PayPal checkouts are branched out earlier in the
 * actions (they return a ProcessorBillingResult directly); this runs the
 * DB-only autumn stage, with an optional deferred processor checkout result
 * attached by the caller.
 */
export const executeBillingPlan = async ({
	ctx,
	billingContext,
	billingPlan,
	processorResult,
	checkoutLockParamsHash,
}: {
	ctx: AutumnContext;
	billingContext: BillingContext;
	billingPlan: BillingPlan;
	/** Processor-side result (e.g. a PayPal checkout the customer must approve). */
	processorResult?: ProcessorBillingResult;
	checkoutLockParamsHash?: string;
}): Promise<BillingResult> => {
	if (processorResult?.deferred) {
		if (checkoutLockParamsHash && processorResult.checkoutId) {
			await checkoutSessionLock.set({
				ctx,
				customerId:
					billingContext.fullCustomer.id ??
					billingContext.fullCustomer.internal_id,
				data: {
					paramsHash: checkoutLockParamsHash,
					checkoutSessionUrl: processorResult.checkoutUrl ?? "",
					checkoutSessionId: processorResult.checkoutId,
				},
			});
		}

		return {
			processor: processorResult,
		};
	}

	await executeAutumnBillingPlan({
		ctx,
		autumnBillingPlan: billingPlan.autumn,
		autumnInvoice: processorResult?.autumnInvoice,
	});

	// Queue webhooks after Autumn billing plan is executed
	await billingPlanToSendProductsUpdated({
		ctx,
		autumnBillingPlan: billingPlan.autumn,
		billingContext,
	});

	// Fire-and-forget: don't block the action on svix delivery
	void sendBillingUpdatedWebhook({
		ctx,
		autumnBillingPlan: billingPlan.autumn,
		originalFullCustomer: billingContext.fullCustomer,
	});

	return { processor: processorResult };
};
