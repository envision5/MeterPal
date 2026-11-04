import {
	type AutumnBillingPlan,
	isCustomerProductOnProcessorSubscription,
	type MultiUpdatePreviewResponseV0,
	type MultiUpdateSubscriptionPreviewV0,
	orgToCurrency,
} from "@autumn/shared";
import { Decimal } from "decimal.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { mergeAutumnBillingPlans } from "@/internal/billing/v2/utils/billingPlan/mergeAutumnBillingPlans";
import { computeAttachPreviewBillingPlan } from "@/internal/billing/v2/utils/billingPlan/preview/computeAttachPreviewBillingPlan";
import { billingPlanToPreviewResponse } from "@/internal/billing/v2/utils/billingPlanToPreviewResponse";
import type { MultiUpdateItemResult } from "../compute/computeMultiUpdateFold";

/**
 * Composes one CORE billing preview per processor subscription group — each
 * built by the same builders single-update previews use, from that group's
 * sub-scoped plan and context (own anchor, own tax inheritance) — and sums the
 * totals.
 */
export const buildMultiUpdatePreviewResponse = async ({
	ctx,
	customerId,
	itemResults,
}: {
	ctx: AutumnContext;
	customerId: string;
	itemResults: MultiUpdateItemResult[];
}): Promise<MultiUpdatePreviewResponseV0> => {
	const subscriptions: MultiUpdateSubscriptionPreviewV0[] = [];

	// Group the items by the processor subscription they belong to, so the
	// preview mirrors the per-subscription invoices the update produces.
	const groups = new Map<string, MultiUpdateItemResult[]>();
	for (const itemResult of itemResults) {
		const subscriptionId =
			itemResult.billingContext.customerProduct.subscription_ids?.[0] ?? "";
		const group = groups.get(subscriptionId) ?? [];
		group.push(itemResult);
		groups.set(subscriptionId, group);
	}

	for (const [subscriptionId, groupItems] of groups) {
		const autumnBillingPlan = groupItems.reduce<AutumnBillingPlan>(
			(plan, itemResult) =>
				mergeAutumnBillingPlans({ base: plan, incoming: itemResult.itemPlan }),
			{
				customerId:
					groupItems[0].billingContext.fullCustomer.id ??
					groupItems[0].billingContext.fullCustomer.internal_id,
				insertCustomerProducts: [],
			},
		);

		const preview = await computeAttachPreviewBillingPlan({
			ctx,
			billingContext: groupItems[0].billingContext,
			autumnBillingPlan,
		});

		const basePreview = await billingPlanToPreviewResponse({
			ctx,
			billingContext: groupItems[0].billingContext,
			billingPlan: {
				autumn: autumnBillingPlan,
				preview,
			},
			nextCycleCustomerProductFilter: (customerProduct) =>
				isCustomerProductOnProcessorSubscription({
					customerProduct,
					processorSubscriptionId: subscriptionId,
				}) === true,
		});

		subscriptions.push({
			...basePreview,
			plan_ids: Array.from(
				new Set(
					groupItems.map(
						(itemResult) =>
							itemResult.billingContext.customerProduct.product.id,
					),
				),
			),
		});
	}

	const total = subscriptions
		.reduce((sum, subscription) => sum.add(subscription.total), new Decimal(0))
		.toDP(2)
		.toNumber();

	return {
		object: "multi_update_preview",
		customer_id: customerId,
		currency: orgToCurrency({ org: ctx.org }),
		total,
		subscriptions,
	};
};
