import type { PooledBalanceIdentity } from "../../../models/pooledBalanceModels/pooledBalanceIdentity.js";

export const pooledBalanceIdentityToKey = ({
	identity,
}: {
	identity: PooledBalanceIdentity;
}) =>
	JSON.stringify([
		identity.internalFeatureId,
		identity.unlimited,
		identity.interval,
		identity.intervalCount,
		identity.resetCycleAnchor,
		identity.resetMode,
		identity.processorSubscriptionId,
		identity.customerLicenseLinkId,
		identity.rolloverSignature,
	]);
