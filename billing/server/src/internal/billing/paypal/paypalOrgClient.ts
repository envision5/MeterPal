// billing/server/src/internal/billing/paypal/paypalOrgClient.ts
//
// Resolves the PayPal client for a checkout that has no auth context.
//
// The public PayPal routes (/paypal/return, /paypal/poll, /paypal/capture)
// are called by the buyer's browser and by the host app, so there is no
// request context to read the org from.  The checkout's own intent row
// carries it: the order was created FOR that org, so that is the org whose
// PayPal account the capture belongs to.

import { eq } from "drizzle-orm";
import { paypalOrderIntents, type AppEnv } from "@autumn/shared";
import { db } from "@/db/initDrizzle.js";
import { getPaypalClient, type PaypalClient } from "@/external/paypal/paypalClient.js";
import { OrgService } from "@/internal/orgs/OrgService.js";

/** The PayPal client for an org, or null when the org does not exist. */
export async function getPaypalClientForOrg(
	orgId: string,
	env: AppEnv,
): Promise<PaypalClient | null> {
	try {
		const org = await OrgService.get({ db, orgId });
		return await getPaypalClient({ org, env });
	} catch {
		return null;
	}
}

/**
 * The PayPal client for a checkout, resolved from its intent row.
 *
 * Returns null when the order is unknown to us — an order we never created
 * must never be captured against some org's PayPal account.
 */
export async function getPaypalClientForOrder(
	orderId: string,
): Promise<PaypalClient | null> {
	if (!orderId) return null;
	const [intent] = await db
		.select({ org_id: paypalOrderIntents.org_id, env: paypalOrderIntents.env })
		.from(paypalOrderIntents)
		.where(eq(paypalOrderIntents.order_id, orderId))
		.limit(1);
	if (!intent) return null;
	return getPaypalClientForOrg(intent.org_id, intent.env as AppEnv);
}

/**
 * The PayPal client for a subscription, resolved from the checkout that
 * created it.
 */
export async function getPaypalClientForSubscription(
	subscriptionId: string,
): Promise<PaypalClient | null> {
	if (!subscriptionId) return null;
	const [intent] = await db
		.select({ org_id: paypalOrderIntents.org_id, env: paypalOrderIntents.env })
		.from(paypalOrderIntents)
		.where(eq(paypalOrderIntents.subscription_id, subscriptionId))
		.limit(1);
	if (!intent) return null;
	return getPaypalClientForOrg(intent.org_id, intent.env as AppEnv);
}
