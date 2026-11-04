// billing/server/src/internal/billing/paypal/paypalCatalogSync.ts
//
// Keeps a product's PayPal billing plan in step with its MeterPal definition.
//
// PayPal plans are nearly immutable: their REGULAR-cycle price can be updated
// in place (POST /v1/billing/plans/{id}/update-pricing-schemes — future
// subscriptions are charged the new amount; existing ones are unaffected for
// payments within 10 days of the change), but the billing interval cannot —
// an interval change means deactivating the plan and creating a new one.
//
// Sync runs:
//   - on plan edit (updateProduct), best-effort, and
//   - before charging a mapped plan at checkout (ensurePaypalPlan), so a
//     buyer is never charged a stale price even when the edit-time sync
//     failed (PayPal down, credentials rotated...).
//
// Products without a mapping are skipped: the checkout provisions lazily via
// ensurePaypalPlan, exactly as before.

import {
	type AppEnv,
	type BillingInterval,
	type FullProduct,
	type Organization,
	paypalCatalogMap,
} from "@autumn/shared";
import { and, eq } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import {
	getPaypalClient,
	hasPaypalConnection,
	type PaypalClient,
} from "@/external/paypal/paypalClient.js";
import {
	deactivateBillingPlan,
	getBillingPlan,
	patchBillingPlan,
	regularCycleSequence,
	updatePlanPricing,
} from "@/external/paypal/subscriptions.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import {
	ensurePaypalPlan,
	priceAmountUsd,
	recurringFixedPrice,
} from "./runPaypalCheckout.js";

export interface PaypalPlanResyncDecision {
	/** The mapped plan is already in step — nothing to do. */
	action: "in_sync" | "update_price" | "recreate_plan";
	/** Current MeterPal price for the plan. */
	amountUsd: number | null;
	interval: BillingInterval | null;
	previousAmountUsd: number | null;
	previousInterval: BillingInterval | null;
	/** Map row's plan name is behind the product name. */
	nameChanged: boolean;
}

/**
 * Pure decision: does the paypal_catalog_map row still match the product's
 * recurring price?  Exported for tests — no I/O.
 */
export function decidePaypalPlanResync({
	mapRow,
	product,
}: {
	mapRow: {
		paypal_plan_id: string | null;
		amount_usd: number | null;
		interval: string | null;
		name?: string | null;
	} | null;
	product: Pick<FullProduct, "name" | "prices">;
}): PaypalPlanResyncDecision {
	const price = recurringFixedPrice(product as FullProduct);
	const amountUsd = price ? priceAmountUsd(price) : null;
	const interval = price
		? ((price.config as { interval?: BillingInterval }).interval ?? null)
		: null;

	const previousAmountUsd = mapRow?.amount_usd ?? null;
	const previousInterval = (mapRow?.interval as BillingInterval | null) ?? null;

	if (!mapRow?.paypal_plan_id) {
		return {
			action: "in_sync", // nothing mapped — checkout will provision
			amountUsd,
			interval,
			previousAmountUsd,
			previousInterval,
			nameChanged: false,
		};
	}

	const amountChanged =
		amountUsd != null &&
		previousAmountUsd != null &&
		amountUsd !== previousAmountUsd;
	const intervalChanged =
		interval != null &&
		previousInterval != null &&
		interval !== previousInterval;
	const nameChanged =
		!!mapRow.name && product.name != null && mapRow.name !== product.name;

	return {
		action: intervalChanged
			? "recreate_plan"
			: amountChanged || nameChanged
				? "update_price"
				: "in_sync",
		amountUsd,
		interval,
		previousAmountUsd,
		previousInterval,
		nameChanged,
	};
}

/**
 * Re-points (or re-prices) the product's PayPal plan to match the product's
 * current recurring price.  Best-effort by design — a PayPal outage must not
 * fail the plan edit; the checkout-time sync retries until it succeeds.
 */
export async function syncPaypalCatalogForProduct({
	db,
	org,
	env,
	product,
}: {
	db: DrizzleCli;
	org: Organization;
	env: AppEnv;
	product: FullProduct;
}): Promise<void> {
	const [mapRow] = await db
		.select()
		.from(paypalCatalogMap)
		.where(
			and(
				eq(paypalCatalogMap.org_id, org.id),
				eq(paypalCatalogMap.env, env),
				eq(paypalCatalogMap.product_id, product.id),
			),
		)
		.limit(1);

	const decision = decidePaypalPlanResync({ mapRow, product });
	if (decision.action === "in_sync") return;

	const log = (msg: string, extra?: Record<string, unknown>) =>
		logger.info({
			msg: `paypal catalog sync: ${msg}`,
			orgId: org.id,
			env,
			productId: product.id,
			decision: decision.action,
			...extra,
		});

	const client: PaypalClient = await getPaypalClient({ org, env });

	if (decision.action === "recreate_plan") {
		// The billing interval changed — a plan cannot be re-intervaled, so
		// retire the old one and mint its replacement.  Existing PayPal
		// subscriptions keep running on the deactivated plan; only NEW
		// checkouts pick the new plan id (revise handles the live ones).
		if (mapRow?.paypal_plan_id) {
			try {
				await deactivateBillingPlan(client, mapRow.paypal_plan_id);
				log("deactivated the stale plan", { planId: mapRow.paypal_plan_id });
			} catch (err) {
				// PayPal refuses to deactivate a plan with active subscribers in
				// some states — the new plan is still created and mapped below.
				logger.warn({
					msg: "paypal catalog sync: could not deactivate the stale plan",
					planId: mapRow.paypal_plan_id,
					error: String(err),
				});
			}
		}
		// Force a fresh plan: pass the EXISTING paypal product id but no plan
		// id, by clearing the map row's plan first.
		await db
			.update(paypalCatalogMap)
			.set({ paypal_plan_id: null })
			.where(eq(paypalCatalogMap.id, mapRow!.id));
		const planId = await ensurePaypalPlan({ client, db, org, env, product });
		log("created the replacement plan", { planId });
		return;
	}

	// update_price (amount and/or name changed)
	if (decision.amountUsd != null && mapRow?.paypal_plan_id) {
		const plan = await getBillingPlan(client, mapRow.paypal_plan_id);
		await updatePlanPricing({
			client,
			planId: mapRow.paypal_plan_id,
			cycleSequence: regularCycleSequence(plan),
			amountUsd: decision.amountUsd,
			idempotencyKey: `mp-plan-price-${org.id}-${env}-${product.id}-${decision.amountUsd}`,
		});
		log("updated the plan price", {
			planId: mapRow.paypal_plan_id,
			from: decision.previousAmountUsd,
			to: decision.amountUsd,
		});
	}
	if (decision.nameChanged && mapRow?.paypal_plan_id) {
		await patchBillingPlan({
			client,
			planId: mapRow.paypal_plan_id,
			name: product.name,
			description: `MeterPal plan ${product.id}`.slice(0, 127),
		});
	}

	// Keep the map row honest so the next decision compares fresh values.
	await db
		.update(paypalCatalogMap)
		.set({
			amount_usd: decision.amountUsd ?? mapRow?.amount_usd,
			interval: decision.interval ?? mapRow?.interval,
			name: product.name,
		})
		.where(eq(paypalCatalogMap.id, mapRow!.id));
}

/**
 * Plan-edit hook: re-sync the PayPal plan when the org bills through PayPal
 * and the product has a mapping.  Best-effort — a PayPal outage must not
 * fail the edit (the checkout-time sync in ensurePaypalPlan retries).
 */
export async function syncPaypalPlanIfConnected({
	ctx,
	product,
}: {
	ctx: AutumnContext;
	product: FullProduct;
}): Promise<void> {
	if (!hasPaypalConnection({ org: ctx.org, env: ctx.env })) return;
	try {
		await syncPaypalCatalogForProduct({
			db: ctx.db,
			org: ctx.org,
			env: ctx.env,
			product,
		});
	} catch (err) {
		ctx.logger.warn({
			msg: "paypal catalog sync: plan-edit sync failed — checkout will retry",
			orgId: ctx.org.id,
			env: ctx.env,
			productId: product.id,
			error: String(err),
		});
	}
}
