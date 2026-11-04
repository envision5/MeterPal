import {
	entToPooledBalanceIdentity,
	type FullCustomerEntitlement,
	type PooledBalanceIdentity,
} from "@autumn/shared";
import type { PooledBalanceLifecycle } from "../types/pooledBalanceComputeTypes";

type PooledBalanceIdentityLifecycle = Pick<
	PooledBalanceLifecycle,
	| "resetCycleAnchor"
	| "resetMode"
	| "processorSubscriptionId"
	| "customerLicenseLinkId"
>;

export const initCustomerEntitlementPooledIdentity = ({
	customerEntitlement,
	lifecycle,
}: {
	customerEntitlement: FullCustomerEntitlement;
	lifecycle: PooledBalanceIdentityLifecycle;
}): PooledBalanceIdentity => ({
	...entToPooledBalanceIdentity({
		entitlement: customerEntitlement.entitlement,
	}),
	resetCycleAnchor: lifecycle.resetCycleAnchor,
	resetMode: lifecycle.resetMode,
	processorSubscriptionId: lifecycle.processorSubscriptionId,
	customerLicenseLinkId: lifecycle.customerLicenseLinkId,
});
