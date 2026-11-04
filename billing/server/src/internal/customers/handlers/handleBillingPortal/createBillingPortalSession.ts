import { type Customer, InternalError, customers } from "@autumn/shared";
import { eq } from "drizzle-orm";
import { db } from "@/db/initDrizzle";
import { createStripeCli } from "../../../../external/connect/createStripeCli";
import { getOrCreateStripeCustomer } from "../../../../external/stripe/customers";
import type { AutumnContext } from "../../../../honoUtils/HonoEnv";
import { toSuccessUrl } from "../../../orgs/orgUtils/convertOrgUtils";
import { isPaypalNativeOrg } from "../../../orgs/orgUtils";
import { portalPageUrl, signPortalToken } from "../../../../utils/portalTokenUtils";
import { createDefaultPortalConfig } from "./createDefaultPortalConfig";

/**
 * Returns the URL the customer should be sent to for self-serve billing.
 *
 * PayPal has no hosted portal equivalent to Stripe's, so PayPal customers get
 * MeterPal's self-hosted portal page instead (token-gated). Customers with a
 * live PayPal subscription get it even in mixed orgs; otherwise any
 * PayPal-native org (PayPal connected, no Stripe) routes there too.
 */
export const createBillingPortalSession = async ({
	ctx,
	customer,
	returnUrl,
	configurationId,
}: {
	ctx: AutumnContext;
	customer: Customer;
	returnUrl?: string;
	configurationId?: string;
}): Promise<{ url: string }> => {
	const { org, env, logger } = ctx;

	// The zod Customer type doesn't carry the PayPal columns — read them off
	// the raw row (same pattern as runPaypalCheckout).
	const [paypalCols] = await db
		.select({ paypal_subscription_id: customers.paypal_subscription_id })
		.from(customers)
		.where(eq(customers.internal_id, customer.internal_id))
		.limit(1);

	if (paypalCols?.paypal_subscription_id || isPaypalNativeOrg({ org, env })) {
		const token = signPortalToken({
			customer_id: customer.id || customer.internal_id,
			org_id: org.id,
			env,
		});
		return { url: portalPageUrl(token) };
	}

	const stripeCli = createStripeCli({ org, env });

	// Determine the Stripe customer ID to use
	const stripeCustomer = await getOrCreateStripeCustomer({
		ctx,
		customer,
	});

	if (!stripeCustomer) {
		throw new InternalError({
			message: `Failed to create billing portal session for customer ${customer.id}, no stripe customer found`,
		});
	}

	const stripeCustomerId = stripeCustomer.id;

	// 1. Try to create billing portal session

	try {
		const session = await stripeCli.billingPortal.sessions.create({
			customer: stripeCustomerId,
			return_url: returnUrl || toSuccessUrl({ org, env }),
			configuration: configurationId ?? undefined,
		});
		return { url: session.url };
	} catch (error: any) {
		// If configurationId was provided, don't fall back to default
		if (configurationId) {
			throw error;
		}

		// If not a missing configuration error, rethrow
		if (
			!error.message?.includes("default configuration has not been created")
		) {
			throw error;
		}

		// Handle missing configuration by creating default and retrying
		logger.info(
			`Creating default billing portal configuration for customer ${customer.id}`,
		);

		const configuration = await createDefaultPortalConfig(stripeCli).catch(
			(configError: any) => {
				logger.error("Failed to create billing portal configuration", {
					error: configError.message,
					orgId: org.id,
				});
				throw new InternalError({
					message: `Failed to create billing portal configuration: ${configError.message}`,
				});
			},
		);

		logger.info("Successfully created billing portal configuration", {
			configurationId: configuration.id,
			orgId: org.id,
		});

		// Retry with new configuration
		const session = await stripeCli.billingPortal.sessions.create({
			customer: stripeCustomerId,
			return_url: returnUrl || toSuccessUrl({ org, env }),
			configuration: configuration.id,
		});
		return { url: session.url };
	}
};
