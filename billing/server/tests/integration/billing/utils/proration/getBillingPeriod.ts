/**
 * Fetches the billing period for proration calculations.
 *
 * The billing engine keeps the period boundaries in the database
 * (`subscriptions.current_period_start` / `current_period_end`), so this reads
 * them straight from the customer product's subscription rows.
 */

import { customerProducts, subscriptions } from "@autumn/shared";
import { eq, inArray } from "drizzle-orm";
import ctx from "@tests/utils/testInitUtils/createTestContext.js";
import { CusService } from "@/internal/customers/CusService.js";

export type BillingPeriod = {
	start: number; // ms timestamp
	end: number; // ms timestamp
};

export type GetBillingPeriodParams = {
	customerId: string;
	interval?: "month" | "year";
};

export type GetBillingPeriodResult = {
	billingPeriod: BillingPeriod;
	billingAnchorMs: number; // Original subscription start (billing_cycle_anchor)
};

/**
 * Get billing period for a customer.
 *
 * @param customerId - The Autumn customer ID
 * @param interval - Optional: filter by billing interval ("month" or "year")
 *
 * @throws Error if no subscription found or billing period is missing
 *
 * @example
 * // Simple case - single subscription
 * const { billingPeriod, billingAnchorMs } = await getBillingPeriod({ customerId });
 *
 * @example
 * // Multi-interval - filter by billing interval
 * const { billingPeriod } = await getBillingPeriod({ customerId, interval: "month" });
 */
export const getBillingPeriod = async ({
	customerId,
	interval,
}: GetBillingPeriodParams): Promise<GetBillingPeriodResult> => {
	const fullCustomer = await CusService.getFull({
		ctx,
		idOrInternalId: customerId,
	});

	const internalCustomerId = fullCustomer.internal_id;
	if (!internalCustomerId) {
		throw new Error(`Missing customer record for customer "${customerId}"`);
	}

	const cusProducts = await ctx.db
		.select({ subscription_ids: customerProducts.subscription_ids })
		.from(customerProducts)
		.where(eq(customerProducts.internal_customer_id, internalCustomerId));

	const subscriptionIds = Array.from(
		new Set(cusProducts.flatMap((row) => row.subscription_ids ?? [])),
	);

	if (subscriptionIds.length === 0) {
		throw new Error(`No subscriptions found for customer "${customerId}"`);
	}

	const rows = await ctx.db
		.select()
		.from(subscriptions)
		.where(inArray(subscriptions.id, subscriptionIds));

	if (rows.length === 0) {
		throw new Error(`No subscriptions found for customer "${customerId}"`);
	}

	const subscription = rows[0];
	const periodStart = subscription.current_period_start;
	const periodEnd = subscription.current_period_end;

	if (typeof periodStart !== "number" || typeof periodEnd !== "number") {
		throw new Error(
			`Invalid billing period on subscription: start=${periodStart}, end=${periodEnd}`,
		);
	}

	if (interval) {
		const monthsInPeriod = Math.round(
			(periodEnd - periodStart) / (1000 * 60 * 60 * 24 * 30),
		);
		const matches = interval === "year" ? monthsInPeriod >= 11 : monthsInPeriod <= 1;
		if (!matches) {
			throw new Error(
				`No subscription with interval "${interval}" found for customer "${customerId}"`,
			);
		}
	}

	return {
		billingPeriod: {
			start: periodStart,
			end: periodEnd,
		},
		billingAnchorMs: (subscription.billing_cycle_anchor_seconds ?? 0) * 1000,
	};
};
