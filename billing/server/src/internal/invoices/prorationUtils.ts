import {
	BillingInterval,
	getCycleEnd,
	getCycleStart,
	type IntervalConfig,
} from "@autumn/shared";
import { Decimal } from "decimal.js";
import {
	getAlignedUnix,
	getPeriodStartForEnd,
} from "@/internal/products/prices/billingIntervalUtils2.js";
import { subtractIntervalForProration } from "@/internal/products/prices/billingIntervalUtils.js";

export type Proration = {
	start: number;
	end: number;
};

/**
 * @deprecated Use `applyProration` from `@shared/utils/billingUtils/invoicingUtils/prorationUtils/applyProration` instead
 */
export const calculateProrationAmount = ({
	periodEnd,
	periodStart,
	now,
	amount,
	allowNegative = false,
}: {
	periodEnd: number;
	periodStart: number;
	now: number;
	amount: number;
	allowNegative?: boolean;
}) => {
	const num = new Decimal(periodEnd).minus(now);
	const denom = new Decimal(periodEnd).minus(periodStart);

	const proratedAmount = num.div(denom).mul(amount);

	if (proratedAmount.lte(0) && !allowNegative) {
		return 0;
	}

	return proratedAmount.toNumber();
};

/**
 * Resolve the proration window for a billing interval: either the cycle
 * anchored at `anchor`, or the window that ends at `proration.end`.
 */
export const getProration = ({
	proration,
	anchor,
	intervalConfig,
	now,
	floor,
}: {
	proration?: Partial<{
		start: number;
		end: number;
	}>;
	anchor?: number; // used to indicate a future date to anchor the next period end to...
	intervalConfig: IntervalConfig;
	now?: number;
	floor?: number;
}) => {
	let { interval, intervalCount } = intervalConfig;
	intervalCount = intervalCount ?? 1;
	now = now || Date.now();

	if (interval === BillingInterval.OneOff) return undefined;

	if (anchor) {
		const start = getCycleStart({
			anchor,
			interval,
			intervalCount,
			now,
			floor,
		});
		const end = getCycleEnd({
			anchor,
			interval,
			intervalCount,
			now,
		});
		return {
			start,
			end,
		};
	}

	let end = proration?.end;
	if (!end && anchor) {
		end = getAlignedUnix({
			anchor: anchor!,
			intervalConfig,
			now,
		});
	}

	let start = proration?.start;
	if (!start && end && anchor) {
		// Find the period start by iterating from the anchor until we reach the period that contains 'now'
		// This ensures we get the correct period even when the anchor day doesn't exist in some months
		// e.g., anchor=31 Oct, now=14 Nov, end=30 Nov -> start should be 31 Oct, not 30 Oct
		start = getPeriodStartForEnd({
			anchor,
			intervalConfig,
			targetEnd: end,
		});
	} else if (!start && end) {
		// Fallback to old behavior if no anchor is provided
		start = subtractIntervalForProration({
			unixTimestamp: end!,
			interval,
			intervalCount,
		});
	}

	if (!start || !end) return undefined;

	return {
		start,
		end,
	};
};
