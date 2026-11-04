import type { AutumnBillingPlan } from "@autumn/shared";
import { cp, PooledBalanceResetMode } from "@autumn/shared";
import { getPatchedCustomerProductUpdates } from "@/internal/billing/v2/utils/billingPlan/customerProductPlanMutations.js";
import { customerProductHasPaidLicenses } from "@/internal/billing/v2/utils/customerProductHasPaidLicenses.js";

/**
 * Stamps the processor subscription id onto a billing plan, so the customer
 * products, their patches and their subscription-scoped pools all point at the
 * same processor subscription.
 */
export const addProcessorSubscriptionIdToBillingPlan = ({
	autumnBillingPlan,
	processorSubscriptionId,
	billingCycleAnchorMs,
}: {
	autumnBillingPlan: AutumnBillingPlan;
	processorSubscriptionId: string;
	billingCycleAnchorMs?: number;
}) => {
	for (const customerProduct of autumnBillingPlan.insertCustomerProducts) {
		const { valid: isPaidRecurring } = cp(customerProduct).paid().recurring();

		if (!isPaidRecurring && !customerProductHasPaidLicenses(customerProduct)) {
			continue;
		}

		customerProduct.subscription_ids = [processorSubscriptionId];
	}

	for (const update of getPatchedCustomerProductUpdates({
		autumnBillingPlan,
	})) {
		update.updates.subscription_ids = [processorSubscriptionId];
	}

	// Inserts only: a pool matched by identity already carries the subscription
	// it belongs to, and restamping an outgoing pool moves it onto an identity
	// another live pool holds.
	for (const pooledCustomerEntitlement of autumnBillingPlan.pooledBalancePlan
		?.insertPoolBalances ?? []) {
		const pooledBalance = pooledCustomerEntitlement.pooled_balance;
		if (pooledBalance?.reset_mode === PooledBalanceResetMode.Subscription) {
			pooledBalance.processor_subscription_id = processorSubscriptionId;
		}
	}

	for (const transition of autumnBillingPlan.customerLicenseTransitions ?? []) {
		transition.billingCycleAnchorMs ??= billingCycleAnchorMs;
	}
};
