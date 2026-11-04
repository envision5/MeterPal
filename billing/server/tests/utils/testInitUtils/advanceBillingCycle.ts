import {
	customerEntitlements,
	customerProducts,
	subscriptions,
} from "@autumn/shared";
import { eq, inArray, sql } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";

/**
 * Shift a customer's billing cycle forward by `deltaMs`.
 *
 * Processor-neutral replacement for the old test clock: the billing
 * engine keeps every cycle boundary in the database (subscription period,
 * entitlement reset anchor, customer product billing anchor), so moving those
 * timestamps forward is all it takes to simulate the passage of time.
 */
export const advanceBillingCycle = async ({
	db,
	internalCustomerId,
	deltaMs,
}: {
	db: DrizzleCli;
	internalCustomerId: string;
	deltaMs: number;
}) => {
	// 1. Customer product billing anchors + trial end.
	await db
		.update(customerProducts)
		.set({
			billing_cycle_anchor: sql`${customerProducts.billing_cycle_anchor} + ${deltaMs}`,
			billing_cycle_anchor_resets_at: sql`${customerProducts.billing_cycle_anchor_resets_at} + ${deltaMs}`,
			trial_ends_at: sql`${customerProducts.trial_ends_at} + ${deltaMs}`,
		})
		.where(eq(customerProducts.internal_customer_id, internalCustomerId));

	// 2. Entitlement reset anchors.
	await db
		.update(customerEntitlements)
		.set({
			next_reset_at: sql`${customerEntitlements.next_reset_at} + ${deltaMs}`,
			reset_cycle_anchor: sql`${customerEntitlements.reset_cycle_anchor} + ${deltaMs}`,
		})
		.where(eq(customerEntitlements.internal_customer_id, internalCustomerId));

	// 3. Subscription period boundaries. Subscriptions are linked to the
	// customer through customer_products.subscription_ids.
	const rows = await db
		.select({ subscription_ids: customerProducts.subscription_ids })
		.from(customerProducts)
		.where(eq(customerProducts.internal_customer_id, internalCustomerId));

	const subscriptionIds = Array.from(
		new Set(rows.flatMap((row) => row.subscription_ids ?? [])),
	);
	if (subscriptionIds.length === 0) {
		return;
	}

	await db
		.update(subscriptions)
		.set({
			current_period_start: sql`${subscriptions.current_period_start} + ${deltaMs}`,
			current_period_end: sql`${subscriptions.current_period_end} + ${deltaMs}`,
			billing_cycle_anchor_seconds: sql`${subscriptions.billing_cycle_anchor_seconds} + ${deltaMs / 1000}`,
		})
		.where(inArray(subscriptions.id, subscriptionIds));
};
