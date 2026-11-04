import { addInterval, BillingInterval, type Price } from "@autumn/shared";

// Backdating creates one line item per backdated billing period, so the number
// of periods a single price spans is capped to keep the invoice sane.
export const BACKDATE_INVOICE_LINE_ITEM_LIMIT = 250;

export const countBackdatedPeriodsForPrice = ({
	price,
	startsAt,
	currentEpochMs,
}: {
	price: Price;
	startsAt: number;
	currentEpochMs: number;
}) => {
	const interval = price.config.interval;
	if (interval === BillingInterval.OneOff) return 0;

	let periods = 0;
	let periodStart = startsAt;

	while (periodStart < currentEpochMs) {
		periods += 1;
		if (periods > BACKDATE_INVOICE_LINE_ITEM_LIMIT) {
			return periods;
		}

		const nextPeriodStart = addInterval({
			from: periodStart,
			interval,
			intervalCount: price.config.interval_count ?? 1,
		});

		if (nextPeriodStart <= periodStart) {
			return Number.POSITIVE_INFINITY;
		}

		periodStart = nextPeriodStart;
	}

	return periods;
};

// Number of in-advance billing periods a backdated price spans, floored at 1
// so non-recurring / not-yet-elapsed prices act as a no-op multiplier.
export const getBackdatedCycleCountForPrice = ({
	price,
	startsAt,
	currentEpochMs,
}: {
	price: Price;
	startsAt: number;
	currentEpochMs: number;
}): number => {
	return Math.max(
		countBackdatedPeriodsForPrice({ price, startsAt, currentEpochMs }),
		1,
	);
};
