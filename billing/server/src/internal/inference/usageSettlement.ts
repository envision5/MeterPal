// billing/server/src/internal/inference/usageSettlement.ts
//
// Reading back what a metered call actually cost.
//
// The gateway's bridge settles usage AFTER it answers the call, so the
// response cannot carry the charge.  The proxy therefore links the two
// halves through the LiteLLM call id: it sends `x-litellm-call-id` with the
// request, the bridge uses that same id as the idempotency key of the
// /track_tokens call, and the resulting event row is found by that key.
// The link is exact -- no guessing by timestamp, no cross-talk between
// concurrent calls.

import {
	AppEnv,
	customerEntitlements,
	customerProducts,
	events,
	features,
} from "@autumn/shared";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";

export type SettledUsage = {
	/** Credits charged for the call. */
	creditsCharged: number;
	/** The customer's balance for the metered feature after the charge. */
	balanceAfter: number | null;
	customerId: string;
	/** The billable model id the charge was recorded against. */
	modelId: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the usage event the bridge writes for this call.
 *
 * Returns null when the event never lands (the bridge is fail-open, so a
 * billing outage still lets the call through) -- the caller then reports
 * the charge as unknown rather than inventing a number.
 */
export const waitForSettledUsage = async ({
	db,
	orgId,
	env,
	customerId,
	callId,
	timeoutMs = 8000,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
	customerId: string;
	callId: string;
	timeoutMs?: number;
}): Promise<SettledUsage | null> => {
	const deadline = Date.now() + timeoutMs;

	while (true) {
		const event = await db.query.events.findFirst({
			where: and(
				eq(events.org_id, orgId),
				eq(events.env, env),
				eq(events.customer_id, customerId),
				eq(events.idempotency_key, callId),
			),
		});

		if (event) {
			return {
				creditsCharged: Number(event.value ?? 0),
				balanceAfter: await getFeatureBalance({
					db,
					customerInternalId: event.internal_customer_id ?? "",
					featureId: event.event_name,
				}),
				customerId,
				modelId: (event.properties?.model_id as string | undefined) ?? null,
				inputTokens: (event.properties?.input_tokens as number | undefined) ?? null,
				outputTokens: (event.properties?.output_tokens as number | undefined) ?? null,
			};
		}

		if (Date.now() >= deadline) return null;
		await sleep(50);
	}
};

/**
 * The customer's spendable balance for one feature, in credits.
 *
 * Only what can actually be spent counts: an entitlement whose product has
 * expired is not spendable, and neither is an expired loose top-up.  This is
 * the same set the admission check gates on, so the number the SDK reports
 * is the number the paywall used.
 */
export const getFeatureBalance = async ({
	db,
	customerInternalId,
	featureId,
}: {
	db: DrizzleCli;
	customerInternalId: string;
	featureId: string;
}): Promise<number | null> => {
	if (!customerInternalId) return null;

	const rows = await db
		.select({ balance: customerEntitlements.balance })
		.from(customerEntitlements)
		.innerJoin(
			features,
			eq(customerEntitlements.internal_feature_id, features.internal_id),
		)
		.leftJoin(
			customerProducts,
			eq(customerEntitlements.customer_product_id, customerProducts.id),
		)
		.where(
			and(
				eq(customerEntitlements.internal_customer_id, customerInternalId),
				eq(features.id, featureId),
				sql`${customerEntitlements.expired} IS NOT TRUE`,
				or(
					// A loose entitlement (no product) is spendable until it expires.
					isNull(customerEntitlements.customer_product_id),
					// A product entitlement counts while its product is active.
					eq(customerProducts.status, "active"),
				),
			),
		);

	if (rows.length === 0) return null;
	return rows.reduce((sum, row) => sum + Number(row.balance ?? 0), 0);
};
