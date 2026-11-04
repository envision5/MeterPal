import {
	type AppEnv,
	type EntInterval,
	type FullCusProduct,
	type Organization,
} from "@autumn/shared";
import { UTCDate } from "@date-fns/utc";
import { clampNextResetAtToPendingBillingCycleAnchor } from "@/internal/billing/v2/utils/billingContext/getRequestedBillingCycleAnchorResetAt";
import { getNextResetAt } from "@/utils/timeUtils.js";

/** Computes next reset timestamp, adjusting for the billing cycle anchor. */
export const getResetAtUpdate = async ({
	curResetAt,
	interval,
	intervalCount,
	cusProduct,
	org,
	env,
}: {
	curResetAt: number;
	interval: EntInterval;
	intervalCount: number;
	cusProduct: FullCusProduct | null;
	org: Organization;
	env: AppEnv;
}): Promise<number> => {
	const nextResetAt = getNextResetAt({
		curReset: new UTCDate(curResetAt),
		interval,
		intervalCount,
	});
	const clampToPendingBillingCycleAnchor = (value: number) =>
		clampNextResetAtToPendingBillingCycleAnchor({
			billingCycleAnchorResetsAt: cusProduct?.billing_cycle_anchor_resets_at,
			currentEpochMs: curResetAt,
			nextResetAt: value,
		});

	return clampToPendingBillingCycleAnchor(nextResetAt);
};
