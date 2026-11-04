import {
	AppEnv,
	type FrontendOrg,
	type Organization,
	OrgConfigSchema,
} from "@autumn/shared";
import { hasPaypalConnection } from "@server/external/paypal/paypalClient.js";

/**
 * True when this org can bill through PayPal in `env`.
 *
 * The org's own `paypal_config` answers for the org; an org without one falls
 * back to the process-wide PAYPAL_* credentials (the single-tenant setup).
 */
export const isPaypalConnected = ({
	org,
	env,
}: {
	org: Organization;
	env: AppEnv;
}) => hasPaypalConnection({ org, env });

/**
 * True when this org bills through PayPal — the only billing processor.
 */
export const isPaypalNativeOrg = ({
	org,
	env,
}: {
	org: Organization;
	env: AppEnv;
}) => isPaypalConnected({ org, env });

export const createOrgResponse = ({
	org,
	env,
}: {
	org: Organization;
	env: AppEnv;
}): FrontendOrg => {
	return {
		id: org.id,
		name: org.name,
		logo: org.logo,
		slug: org.slug,
		master: org.master
			? {
					id: org.master.id,
					name: org.master.name,
					slug: org.master.slug,
				}
			: null,

		success_url: "https://useautumn.com",
		default_currency: org.default_currency || "usd",
		through_master: Boolean(org.master),
		created_at: new Date(org.createdAt).getTime(),
		test_pkey: org.test_pkey,
		live_pkey: org.live_pkey,
		onboarded: org.onboarded ?? true,
		deployed: org.deployed ?? true,
		config: OrgConfigSchema.parse(org.config || {}),
		idempotency_config: org.idempotency_config ?? null,
		custom_buttons: org.custom_buttons ?? [],
		redis_config: org.redis_config
			? {
					host: org.redis_config.url,
					migrationPercent: org.redis_config.migrationPercent,
				}
			: null,
	};
};

export const orgToCurrency = ({ org }: { org: Organization }) => {
	return org.default_currency || "usd";
};
