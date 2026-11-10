import {
	type ApiCustomerV5,
	ApiCustomerV5Schema,
	CustomerExpand,
	type CustomerLegacyData,
	type FullSubject,
	fullSubjectToApiUsageLimits,
	orgToInStatuses,
	scopeExpandForCtx,
} from "@autumn/shared";
import { z } from "zod/v4";
import type { RequestContext } from "@/honoUtils/HonoEnv.js";
import { invoicesToResponse } from "../../../invoices/invoiceUtils.js";
import { getApiBalancesV2 } from "./getApiBalance/getApiBalancesV2.js";
import { getApiCustomerLicenses } from "./getApiCustomerLicense/getApiCustomerLicenses.js";
import { getApiSubscriptionsV2 } from "./getApiSubscription/getApiSubscriptionsV2.js";

/**
 * Get base ApiCustomer without expand fields from FullSubject.
 * By default, it includes the autumn_id.
 */
export const getApiCustomerBaseV2 = async ({
	ctx,
	fullSubject,
	withAutumnId = true,
}: {
	ctx: RequestContext;
	fullSubject: FullSubject;
	withAutumnId?: boolean;
}): Promise<{ apiCustomer: ApiCustomerV5; legacyData: CustomerLegacyData }> => {
	const { balances: apiBalances, flags: apiFlags } = getApiBalancesV2({
		ctx,
		fullSubject,
	});

	const subscriptionsScopedCtx = scopeExpandForCtx({
		ctx,
		prefix: "subscriptions",
	});

	const {
		subscriptions: apiSubscriptions,
		purchases: apiPurchases,
		legacyData: cusProductLegacyData,
	} = await getApiSubscriptionsV2({
		ctx: subscriptionsScopedCtx,
		fullSubject,
	});

	const apiLicenses = getApiCustomerLicenses({
		ctx,
		customerProducts: fullSubject.customer_products,
	});

	const customer = fullSubject.customer;
	const usageLimits = fullSubjectToApiUsageLimits({
		fullSubject,
		features: ctx.features,
		inStatuses: orgToInStatuses({ org: ctx.org }),
	});

	const apiCustomer = ApiCustomerV5Schema.extend({
		autumn_id: z.string().optional(),
	}).parse({
		autumn_id: withAutumnId ? customer.internal_id : undefined,
		id: customer.id || null,
		created_at: customer.created_at,
		name: customer.name || null,
		email: customer.email || null,
		fingerprint: customer.fingerprint || null,
		// Always null (PayPal-native), but the key must be present: the client
		// SDK validates the customer payload against a schema that requires it,
		// and rejects the whole payload when it is missing.
		stripe_id: null,
		env: customer.env,
		metadata: customer.metadata ?? {},
		subscriptions: apiSubscriptions,
		purchases: apiPurchases,
		licenses: apiLicenses,
		balances: apiBalances,
		flags: apiFlags,
		send_email_receipts: customer.send_email_receipts ?? false,
		billing_controls: {
			auto_topups: customer.auto_topups ?? undefined,
			spend_limits: customer.spend_limits ?? undefined,
			usage_limits: usageLimits,
			usage_alerts: customer.usage_alerts ?? undefined,
			overage_allowed: customer.overage_allowed ?? undefined,
		},
		config: customer.config
			? {
					disable_pooled_balance: customer.config.disable_pooled_balance,
					disable_overage_billing:
						customer.config.disable_overage_billing,
				}
			: undefined,
		invoices:
			fullSubject.invoices && ctx.expand.includes(CustomerExpand.Invoices)
				? invoicesToResponse({
						invoices: fullSubject.invoices,
					})
				: undefined,
	} satisfies ApiCustomerV5);

	return {
		apiCustomer,
		legacyData: {
			cusProductLegacyData,
		},
	};
};
