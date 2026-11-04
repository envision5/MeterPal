import type {
	AttachBillingContext,
	FullCusProduct,
	PooledBalancePlan,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { computePooledBalanceTransitionPlan } from "./computePooledBalanceTransitionPlan";

export const computeAttachPooledBalancePlan = ({
	ctx,
	attachBillingContext,
	newCustomerProduct,
}: {
	ctx: AutumnContext;
	attachBillingContext: AttachBillingContext;
	newCustomerProduct: FullCusProduct;
}): {
	customerProduct: FullCusProduct;
	pooledBalancePlan?: PooledBalancePlan;
} => {
	if (attachBillingContext.planTiming !== "immediate") {
		return { customerProduct: newCustomerProduct };
	}

	const { pooledBalancePlan } = computePooledBalanceTransitionPlan({
		ctx,
		fullCustomer: attachBillingContext.fullCustomer,
		outgoingCustomerProducts: attachBillingContext.currentCustomerProduct
			? [attachBillingContext.currentCustomerProduct]
			: [],
		incomingCustomerProducts: [newCustomerProduct],
		processorSubscriptionId:
			attachBillingContext.currentCustomerProduct?.subscription_ids?.[0],
		now: attachBillingContext.currentEpochMs,
	});

	return {
		customerProduct: newCustomerProduct,
		pooledBalancePlan,
	};
};
