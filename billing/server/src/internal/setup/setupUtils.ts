// billing/server/src/internal/setup/setupUtils.ts
//
// The onboarding wizard's shared pieces.
//
// The wizard asks one question at a time and every answer must be a state
// that is really true, so what it reports is read from the tables the
// product runs on -- never from a checklist the wizard keeps for itself.

import {
	AppEnv,
	customers,
	events,
	paypalCatalogMap,
	type FullProduct,
} from "@autumn/shared";
import { and, desc, eq } from "drizzle-orm";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { createCustomerWithDefaults } from "@/internal/customers/actions/createWithDefaults/createCustomerWithDefaults.js";
import { ProductService } from "@/internal/products/ProductService.js";
import { priceAmountUsd } from "@/internal/billing/paypal/runPaypalCheckout.js";
import { getFeatureBalance } from "@/internal/inference/usageSettlement.js";

/**
 * The end user the wizard's smoke test bills.
 *
 * A fixed id so the wizard can find it again after a reload, and a name that
 * says what it is when a merchant reads their own customer list.  It lives in
 * the merchant's own org, so the charge shows up in their usage like any
 * other customer's.
 */
export const SETUP_CUSTOMER_ID = "meterpal-setup-test";
export const SETUP_CUSTOMER_EMAIL = "setup-test@meterpal.local";

export type SetupPlan = {
	/** The MeterPal plan id. */
	product_id: string;
	name: string;
	/** What the plan costs, in USD. Null when it has no fixed price. */
	amount_usd: number | null;
	/** The billing interval, e.g. "month". */
	interval: string | null;
	/** The PayPal plan that bills it. Null until the wizard creates one. */
	paypal_plan_id: string | null;
	paypal_product_id: string | null;
};

/**
 * The org's plans, with their PayPal counterparts.
 *
 * A plan with no PayPal counterpart is one the merchant can sell but cannot
 * yet charge for -- which is exactly the state the wizard's plan step exists
 * to move.
 */
export async function listSetupPlans({
	ctx,
}: {
	ctx: AutumnContext;
}): Promise<SetupPlan[]> {
	const { db, org, env } = ctx;

	const products = await ProductService.listFull({ db, orgId: org.id, env });

	const mappings = await db
		.select({
			product_id: paypalCatalogMap.product_id,
			paypal_plan_id: paypalCatalogMap.paypal_plan_id,
			paypal_product_id: paypalCatalogMap.paypal_product_id,
		})
		.from(paypalCatalogMap)
		.where(
			and(
				eq(paypalCatalogMap.org_id, org.id),
				eq(paypalCatalogMap.env, env),
			),
		);

	const byProductId = new Map(
		mappings.map((m) => [m.product_id, m] as const),
	);

	return products.map((product) => {
		const mapping = byProductId.get(product.id);
		const price = firstRecurringPrice(product);
		return {
			product_id: product.id,
			name: product.name,
			amount_usd: price ? priceAmountUsd(price) : null,
			interval: price
				? ((price.config as { interval?: string }).interval ?? null)
				: null,
			paypal_plan_id: mapping?.paypal_plan_id ?? null,
			paypal_product_id: mapping?.paypal_product_id ?? null,
		};
	});
}

/** The plan's recurring price -- the one a subscription bills. */
function firstRecurringPrice(product: FullProduct) {
	return (
		product.prices.find(
			(p) =>
				(p.config as { interval?: string }).interval !== "one_off" &&
				priceAmountUsd(p) != null,
		) ?? null
	);
}

/**
 * The end user the smoke test bills, created on first use.
 *
 * It goes through the normal customer path, so the org's auto-enabled plans
 * attach to it and it is credited the same way a real end user would be.
 */
export async function ensureSetupCustomer({
	ctx,
}: {
	ctx: AutumnContext;
}) {
	const existing = await ctx.db.query.customers.findFirst({
		where: and(
			eq(customers.org_id, ctx.org.id),
			eq(customers.env, ctx.env),
			eq(customers.id, SETUP_CUSTOMER_ID),
		),
	});

	if (existing?.id) {
		return { ...existing, id: existing.id };
	}

	const created = await createCustomerWithDefaults({
		ctx,
		customerId: SETUP_CUSTOMER_ID,
		customerData: {
			email: SETUP_CUSTOMER_EMAIL,
			name: "Setup test",
		},
	});

	return { ...created, id: created.id };
}

export type SetupSmokeTest = {
	/** Credits the call cost. */
	credits_charged: number | null;
	/** The end user's balance after the call. */
	balance_after: number | null;
	/** The model the call was billed against. */
	model_id: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	/** When the call ran, epoch ms. */
	ran_at: number;
};

/**
 * The last smoke test this org ran.
 *
 * Read from the usage events, so the answer survives a reload and is the
 * same charge the merchant would see in their own usage.
 */
export async function getLastSetupSmokeTest({
	ctx,
}: {
	ctx: AutumnContext;
}): Promise<SetupSmokeTest | null> {
	const { db, org, env } = ctx;

	const event = await db.query.events.findFirst({
		where: and(
			eq(events.org_id, org.id),
			eq(events.env, env),
			eq(events.customer_id, SETUP_CUSTOMER_ID),
		),
		orderBy: desc(events.created_at),
	});

	if (!event) return null;

	// The balance is not on the event -- it is the end user's balance now,
	// which is what the wizard wants to show ("what is left after the test").
	const balanceAfter = await getFeatureBalance({
		db,
		customerInternalId: event.internal_customer_id ?? "",
		featureId: event.event_name,
	});

	return {
		credits_charged: Number(event.value ?? 0),
		balance_after: balanceAfter,
		model_id: (event.properties?.model_id as string | undefined) ?? null,
		input_tokens: (event.properties?.input_tokens as number | undefined) ?? null,
		output_tokens: (event.properties?.output_tokens as number | undefined) ?? null,
		ran_at: event.created_at ? new Date(event.created_at).getTime() : Date.now(),
	};
}

/** The env the wizard's PayPal step talks to. */
export function paypalEnvForEnv(env: AppEnv): "sandbox" | "live" {
	return env === AppEnv.Live ? "live" : "sandbox";
}
