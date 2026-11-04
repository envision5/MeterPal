// billing/server/src/internal/billing/portal/portalRouter.ts
//
// Self-hosted billing portal for PayPal customers (PayPal has no hosted
// portal equivalent to Stripe's). Mounted on the public router — no secret-key
// or session auth. Every route takes a signed, short-lived portal token that
// the billing portal session URL embeds (see utils/portalTokenUtils.ts); the
// token names the org/env/customer, so possession of the link is the
// authorization.

import { and, desc, eq, or } from "drizzle-orm";
import { rateLimiter } from "hono-rate-limiter";
import { Hono } from "hono";
import {
	type Organization,
	CusProductStatus,
	customers,
	customerProducts,
	PriceType,
	RecaseError,
	prices,
	products,
	walletLedger,
} from "@autumn/shared";
import { db } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import { getPaypalClient } from "@/external/paypal/paypalClient.js";
import {
	cancelSubscription,
	getSubscription,
} from "@/external/paypal/subscriptions.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { OrgService } from "@/internal/orgs/OrgService.js";
import {
	verifyPortalToken,
	type PortalTokenPayload,
} from "@/utils/portalTokenUtils.js";

export const portalRouter = new Hono<HonoEnv>();

// Same shape as the invoice redirect limiter — the token is the credential,
// the limiter just blunts brute-force probing of the token namespace.
const portalLimiter = rateLimiter<HonoEnv>({
	windowMs: 60 * 1000,
	limit: 30,
	standardHeaders: "draft-6",
	keyGenerator: (c) =>
		c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown",
});

async function loadPortalContext(
	payload: PortalTokenPayload,
): Promise<{ customer: typeof customers.$inferSelect; org: Organization }> {
	const [customer] = await db
		.select()
		.from(customers)
		.where(
			and(
				eq(customers.org_id, payload.org_id),
				eq(customers.env, payload.env),
				or(
					eq(customers.id, payload.customer_id),
					eq(customers.internal_id, payload.customer_id),
				),
			),
		)
		.limit(1);

	if (!customer) {
		throw new RecaseError({
			message: "Portal customer not found",
			statusCode: 404,
		});
	}

	const org = await OrgService.get({ db, orgId: payload.org_id });
	return { customer, org };
}

portalRouter.get("/:token", portalLimiter, async (c) => {
	const payload = verifyPortalToken(c.req.param("token"));
	if (!payload) {
		throw new RecaseError({
			message: "Invalid or expired portal link",
			statusCode: 401,
		});
	}

	const { customer, org } = await loadPortalContext(payload);

	// Active plan — most recent active customer product, with its fixed price
	// when the plan has one (usage/overage-only plans show name only).
	const [activeProduct] = await db
		.select({
			internal_product_id: customerProducts.internal_product_id,
			product_name: products.name,
		})
		.from(customerProducts)
		.innerJoin(
			products,
			eq(products.internal_id, customerProducts.internal_product_id),
		)
		.where(
			and(
				eq(customerProducts.internal_customer_id, customer.internal_id),
				eq(customerProducts.status, CusProductStatus.Active),
			),
		)
		.orderBy(desc(customerProducts.created_at))
		.limit(1);

	let plan: {
		name: string | null;
		amount: number | null;
		interval: string | null;
	} | null = null;

	if (activeProduct) {
		const priceRows = await db
			.select({ config: prices.config })
			.from(prices)
			.where(eq(prices.internal_product_id, activeProduct.internal_product_id));

		const fixedConfig = priceRows
			.map((row) => row.config)
			.find((config) => config?.type === PriceType.Fixed) as
			| { amount: number; interval: string }
			| undefined;

		plan = {
			name: activeProduct.product_name,
			amount: fixedConfig?.amount ?? null,
			interval: fixedConfig?.interval ?? null,
		};
	}

	// Live subscription status + payer email straight from PayPal — the stored
	// paypal_payment_status is webhook-driven and can lag. If PayPal is
	// unreachable, degrade to the stored state rather than erroring the page.
	let paypalStatus: string | null = null;
	let payerEmail: string | null = customer.email ?? null;
	if (customer.paypal_subscription_id) {
		try {
			const client = await getPaypalClient({ org, env: payload.env });
			const subscription = await getSubscription(
				client,
				customer.paypal_subscription_id,
			);
			paypalStatus = subscription.status ?? null;
			payerEmail = subscription.subscriber?.email_address ?? payerEmail;
		} catch (error: any) {
			logger.warn({
				msg: "portal: PayPal subscription lookup failed, using stored state",
				customer_id: customer.id,
				error: String(error?.message ?? error),
			});
		}
	}

	const ledgerRows = await db
		.select()
		.from(walletLedger)
		.where(eq(walletLedger.customer_id, customer.id ?? ""))
		.orderBy(desc(walletLedger.created_at))
		.limit(25);

	return c.json({
		org_name: org.name,
		customer: {
			id: customer.id,
			name: customer.name,
			email: customer.email,
		},
		subscription: {
			paypal_subscription_id: customer.paypal_subscription_id,
			status: customer.paypal_payment_status,
			paypal_status: paypalStatus,
			plan,
		},
		payment_method: {
			type: "paypal",
			email: payerEmail,
		},
		history: ledgerRows.map((row) => ({
			date: row.created_at,
			description: row.event_name ?? row.kind,
			amount_usd: row.amount_usd,
			kind: row.kind,
		})),
	});
});

portalRouter.post("/cancel/:token", portalLimiter, async (c) => {
	const payload = verifyPortalToken(c.req.param("token"));
	if (!payload) {
		throw new RecaseError({
			message: "Invalid or expired portal link",
			statusCode: 401,
		});
	}

	const { customer, org } = await loadPortalContext(payload);

	if (!customer.paypal_subscription_id) {
		throw new RecaseError({
			message: "This customer has no PayPal subscription to cancel",
			statusCode: 400,
		});
	}

	// Idempotent — a repeat click (or a race with the BILLING.SUBSCRIPTION
	// .CANCELLED webhook, which records the same state) must not re-call PayPal.
	if (customer.paypal_payment_status === "cancelled") {
		return c.json({ status: "cancelled" });
	}

	const client = await getPaypalClient({ org, env: payload.env });
	await cancelSubscription(
		client,
		customer.paypal_subscription_id,
		"Cancelled from billing portal",
	);

	await db
		.update(customers)
		.set({ paypal_payment_status: "cancelled" })
		.where(
			and(
				eq(customers.internal_id, customer.internal_id),
				eq(customers.paypal_subscription_id, customer.paypal_subscription_id),
			),
		);

	return c.json({ status: "cancelled" });
});
