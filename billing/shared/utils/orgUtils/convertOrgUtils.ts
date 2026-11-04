import { AppEnv, type Feature, type SharedContext } from "../../index.js";
import { CusProductStatus } from "../../models/cusProductModels/cusProductEnums.js";
import type { Organization } from "../../models/orgModels/orgTable.js";

export const orgToInStatuses = ({ org }: { org: Organization }) => {
	if (org.config.include_past_due || org.config.block_overdue_entitlements) {
		return [CusProductStatus.Active, CusProductStatus.PastDue];
	}
	return [CusProductStatus.Active];
};

export const orgToCurrency = ({ org }: { org: Organization }) => {
	return org.default_currency || "usd";
};

/**
 * Fallback return URL when a request doesn't pass `success_url`. The PayPal
 * checkout ignores this (the server return route owns the landing page via
 * METERPAL_CHECKOUT_RETURN_URL); DB-only checkouts redirect here.
 */
export const orgToReturnUrl = ({
	org,
	env,
}: {
	org: Organization;
	env: AppEnv;
}) => {
	void org;
	void env;
	return "https://useautumn.com";
};

export const orgDefaultAppliesToEntities = ({
	ctx,
}: {
	ctx: SharedContext;
}) => {
	return ctx.org.config.default_applies_to_entities;
};

/**
 * Whether the org has blocked writes to its billing processor.
 *
 * The config field keeps its historical name because it lives in a JSONB blob
 * on `orgs.config` and renaming it there would orphan every existing row. The
 * flag gates processor (PayPal) writes.
 */
export const orgDisableProcessorWrites = ({
	ctx,
	includeSandbox = false,
}: {
	ctx: SharedContext;
	includeSandbox?: boolean;
}) => {
	if (ctx.env === AppEnv.Sandbox && !includeSandbox) {
		return false;
	}
	return ctx.org.config.disable_processor_writes;
};

export const orgPersistFreeOverage = ({ org }: { org: Organization }) => {
	return org.config.persist_free_overage ?? false;
};

export const orgMultiCurrencyEnabled = ({ org }: { org: Organization }) => {
	return org.config.multi_currency ?? false;
};

export const orgToFeaturesByOrgEnv = ({
	org,
	env,
	features,
}: {
	org: Organization;
	env: AppEnv;
	features: Feature[];
}) => {
	return {
		[`${org.id}:${env}`]: features,
	};
};
export const shouldForwardCustomerMetadata = ({
	org,
}: {
	org: Organization;
}) => {
	return org.config.forward_customer_metadata;
};
