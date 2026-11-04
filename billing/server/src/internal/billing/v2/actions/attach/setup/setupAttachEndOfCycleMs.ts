import type { PlanTiming } from "@autumn/shared";
import {
	cusProductToPrices,
	type FullCusProduct,
	getCycleEnd,
} from "@autumn/shared";
import { getLargestInterval } from "@/internal/products/prices/priceUtils/priceIntervalUtils";

/** Resolves a scheduled attachment's cycle boundary from Autumn's own state. */
export const setupAttachEndOfCycleMs = ({
	planTiming,
	currentCustomerProduct,
	billingCycleAnchorMs,
	currentEpochMs,
}: {
	planTiming: PlanTiming;
	currentCustomerProduct?: FullCusProduct;
	billingCycleAnchorMs?: number | "now";
	currentEpochMs: number;
}): number | undefined => {
	if (planTiming !== "end_of_cycle") {
		return undefined;
	}

	// Transitioning from an existing product (upgrade/downgrade): the cycle
	// boundary is the end of the outgoing product's largest recurring interval.
	if (currentCustomerProduct && billingCycleAnchorMs !== undefined) {
		const currentPrices = cusProductToPrices({
			cusProduct: currentCustomerProduct,
		});

		const largestInterval = getLargestInterval({
			prices: currentPrices,
			excludeOneOff: true,
		});

		if (largestInterval) {
			return getCycleEnd({
				anchor: billingCycleAnchorMs,
				interval: largestInterval.interval,
				intervalCount: largestInterval.intervalCount,
				now: currentEpochMs,
				floor:
					billingCycleAnchorMs === "now" ? undefined : billingCycleAnchorMs,
			});
		}
	}

	return undefined;
};
