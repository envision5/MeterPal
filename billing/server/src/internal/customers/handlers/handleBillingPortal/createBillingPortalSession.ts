import { type Customer } from "@autumn/shared";
import type { AutumnContext } from "../../../../honoUtils/HonoEnv";
import { portalPageUrl, signPortalToken } from "../../../../utils/portalTokenUtils";

/**
 * Returns the URL the customer should be sent to for self-serve billing.
 *
 * PayPal has no hosted portal, so customers get MeterPal's self-hosted
 * portal page instead (token-gated).
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
	/** Unused — the self-hosted portal has no processor-side configurations. */
	configurationId?: string;
}): Promise<{ url: string }> => {
	const { org, env } = ctx;

	const token = signPortalToken({
		customer_id: customer.id || customer.internal_id,
		org_id: org.id,
		env,
	});
	return { url: portalPageUrl(token) };
};
