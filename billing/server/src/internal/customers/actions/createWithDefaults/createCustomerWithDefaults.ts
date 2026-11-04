import { type CustomerData, type FullCustomer } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { sendBillingUpdatedWebhook } from "@/internal/billing/v2/workflows/sendBillingUpdatedWebhook/sendBillingUpdatedWebhook.js";
import { billingPlanToSendProductsUpdated } from "@/internal/billing/v2/workflows/sendProductsUpdated/billingPlanToSendProductsUpdated.js";
import { setCustomerCreationRecoveryStage } from "@/internal/customers/recovery/customerCreationRecoveryStage.js";
import { computeCreateCustomerPlan } from "./compute/computeCreateCustomerPlan.js";
import { executeAutumnCreateCustomerPlan } from "./execute/executeAutumnCreateCustomerPlan.js";
import {
	logAutumnPlanResult,
	logCreateCustomerContext,
} from "./logs/logCreateCustomer.js";
import { setupCreateCustomer } from "./setup/setupCreateCustomer.js";

/**
 * Create a customer and attach default products.
 *
 * Phase 1 - Create Autumn customer:
 *   setup → compute → execute
 *
 * The billing engine is DB-only: a PayPal subscription for a paid default is
 * created by the checkout flow, not inline here.
 *
 * Idempotency:
 * - Email exists with id=NULL, new request has id=NULL: Returns existing customer
 * - Email exists with id=NULL, new request has ID: Claims the row (sets ID)
 * - Customer ID already exists: Returns existing customer
 */
export const createCustomerWithDefaults = async ({
	ctx,
	customerId,
	customerData,
}: {
	ctx: AutumnContext;
	customerId: string | null;
	customerData?: CustomerData;
}): Promise<FullCustomer> => {
	setCustomerCreationRecoveryStage({ ctx, stage: "pre_commit" });

	// ============ Phase 1: Create Autumn customer ============

	// 1. Setup
	const context = await setupCreateCustomer({
		ctx,
		customerId,
		customerData,
	});

	logCreateCustomerContext({ ctx, context });

	// 2. Compute
	const autumnBillingPlan = computeCreateCustomerPlan({ ctx, context });

	// 3. Execute Autumn
	const autumnResult = await executeAutumnCreateCustomerPlan({
		ctx,
		context,
		autumnBillingPlan,
	});

	logAutumnPlanResult({ ctx, result: autumnResult });

	// Early return if customer already existed
	if (autumnResult.type === "existing") {
		setCustomerCreationRecoveryStage({ ctx, stage: "completed" });
		return context.fullCustomer;
	}

	// Webhook consumers call customers.get on receipt, so emission happens once
	// the customer row is committed. Phase 1 is committed either way, and a
	// throw must not drop the webhooks — a client retry lands on the "existing"
	// path above and would never emit them.
	try {
		setCustomerCreationRecoveryStage({ ctx, stage: "completed" });
		return context.fullCustomer;
	} finally {
		await billingPlanToSendProductsUpdated({
			ctx,
			autumnBillingPlan,
			billingContext: context,
		});

		// Fire-and-forget: don't block customer creation on svix delivery
		void sendBillingUpdatedWebhook({
			ctx,
			autumnBillingPlan,
			originalFullCustomer: context.fullCustomer,
		});
	}
};
