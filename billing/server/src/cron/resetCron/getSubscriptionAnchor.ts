import { EntInterval, getCycleEnd, type ResetCusEnt } from "@autumn/shared";
import { UTCDate } from "@date-fns/utc";
import { format, getDate, getMonth } from "date-fns";
import type { DrizzleCli } from "@/db/initDrizzle";
import { CusProductService } from "@/internal/customers/cusProducts/CusProductService";

const shortDurations: string[] = [
	EntInterval.Minute,
	EntInterval.Hour,
	EntInterval.Day,
];

/**
 * Aligns the next entitlement reset with the plan's billing cycle anchor.
 *
 * The anchor is read from the customer product — the billing engine is
 * DB-only, so the processor subscription is never consulted.
 */
export const getSubscriptionAnchor = async ({
	db,
	cusEnt,
	curResetAt,
	nextResetAt,
}: {
	db: DrizzleCli;
	cusEnt: ResetCusEnt;
	curResetAt: number;
	nextResetAt: number;
}) => {
	const entInterval = cusEnt.entitlement?.interval;
	if (!entInterval) return nextResetAt;
	if (shortDurations.includes(entInterval)) return nextResetAt;

	const nextResetAtDate = new UTCDate(nextResetAt);

	// Only check the anchor on edge dates (28th Feb, 30th of month)
	const nextResetAtDay = getDate(nextResetAtDate);
	const nextResetAtMonth = getMonth(nextResetAtDate);

	const shouldCheck =
		nextResetAtDay === 30 || (nextResetAtDay === 28 && nextResetAtMonth === 1);

	if (!shouldCheck) return nextResetAt;

	// 1. Get the customer product
	const cusProduct = await CusProductService.getByIdForReset({
		db,
		id: cusEnt.customer_product_id ?? "",
	});

	if (
		!cusProduct.subscription_ids ||
		cusProduct.subscription_ids.length === 0
	) {
		return nextResetAt;
	}

	const billingCycleAnchor = cusProduct.billing_cycle_anchor;
	if (!billingCycleAnchor) return nextResetAt;

	console.log("Checking billing cycle anchor");
	console.log(
		"Current reset at    ",
		format(new UTCDate(curResetAt), "dd MMM yyyy HH:mm:ss"),
	);
	console.log(
		"Next reset at       ",
		format(new UTCDate(nextResetAt), "dd MMM yyyy HH:mm:ss"),
	);
	console.log(
		"Billing cycle anchor",
		format(new UTCDate(billingCycleAnchor), "dd MMM yyyy HH:mm:ss"),
	);

	const alignedResetAt = getCycleEnd({
		anchor: billingCycleAnchor,
		interval: entInterval,
		intervalCount: cusEnt.entitlement.interval_count ?? 1,
		now: curResetAt,
	});
	return Math.max(nextResetAt, alignedResetAt);
};
