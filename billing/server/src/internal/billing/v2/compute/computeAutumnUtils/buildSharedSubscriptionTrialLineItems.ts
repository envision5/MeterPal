import type { AutumnBillingPlan } from "@autumn/shared";
import {
	type BillingContext,
	cp,
	type FullCusProduct,
	type LineItem,
} from "@autumn/shared";
import chalk from "chalk";
import type { Logger } from "@/external/logtail/logtailUtils";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { getTrialStateTransition } from "@/internal/billing/v2/utils/billingContext/getTrialStateTransition";
import {
	getDeleteCustomerProducts,
	getUpdateCustomerProducts,
} from "@/internal/billing/v2/utils/billingPlan/customerProductPlanMutations";
import { getLineItemsForDirection } from "@/internal/billing/v2/utils/lineItems/getLineItemsForDirection";

const formatLineItem = (item: LineItem) => ({
	description: item.description,
	amount: item.amount,
	amountAfterDiscounts: item.amountAfterDiscounts,
});

const logSharedSubscriptionTrialLineItems = ({
	logger,
	direction,
	siblingCustomerProducts,
	lineItems,
}: {
	logger: Logger;
	direction: "charge" | "refund";
	siblingCustomerProducts: FullCusProduct[];
	lineItems: LineItem[];
}) => {
	const formatLineItemCompact = (item: LineItem) =>
		`  ${item.description}: ${chalk.yellow(item.amountAfterDiscounts.toFixed(2))}`;

	// Structured info log
	// logger.info(`buildSharedSubscriptionTrialLineItems data`, {
	// 	data: {
	// 		direction,
	// 		sibilingCustomerProducts: siblingCustomerProducts.map(
	// 			(customerProduct) => ({
	// 				id: customerProduct.id,
	// 				productId: customerProduct.product?.id,
	// 				entityId: customerProduct.entity_id,
	// 			}),
	// 		),
	// 		lineItems: lineItems.map(formatLineItem),
	// 	},
	// });

	// Debug output
	logger.debug("========== [buildSharedSubscriptionTrialLineItems] ==========");
	logger.debug("");
	logger.debug(`direction: ${direction}`);
	logger.debug(
		`siblingCustomerProducts: ${siblingCustomerProducts.map((cp) => cp.id).join(", ")}`,
	);
	logger.debug("");
	logger.debug("lineItems:");
	if (lineItems.length === 0) logger.debug("  (none)");
	else for (const item of lineItems) logger.debug(formatLineItemCompact(item));
	logger.debug("");
	logger.debug(
		"==============================================================",
	);
};

/** Filter for sibling customer products on the same processor subscription. */
const getSiblingCustomerProducts = ({
	customerProducts,
	autumnBillingPlan,
	processorSubscriptionId,
}: {
	customerProducts: FullCusProduct[];
	autumnBillingPlan: AutumnBillingPlan;
	processorSubscriptionId: string;
}): FullCusProduct[] => {
	const handledIds = new Set([
		...autumnBillingPlan.insertCustomerProducts.map((cp) => cp.id),
		...getUpdateCustomerProducts({ autumnBillingPlan }).map(
			(updateCustomerProduct) => updateCustomerProduct.customerProduct.id,
		),
		...getDeleteCustomerProducts({ autumnBillingPlan }).map(
			(customerProduct) => customerProduct.id,
		),
	]);

	return customerProducts.filter((customerProduct) => {
		if (handledIds.has(customerProduct.id)) return false;

		return cp(customerProduct)
			.paid()
			.recurring()
			.onProcessorSubscription({ processorSubscriptionId }).valid;
	});
};

/**
 * Builds line items for sibling customer products on a shared processor
 * subscription when trial state changes (trialing → no trial or no trial →
 * trialing).
 */
export const buildSharedSubscriptionTrialLineItems = ({
	ctx,
	billingContext,
	autumnBillingPlan,
}: {
	ctx: AutumnContext;
	billingContext: BillingContext & {
		currentCustomerProduct?: FullCusProduct;
		customerProduct?: FullCusProduct;
	};
	autumnBillingPlan: AutumnBillingPlan;
}): LineItem[] => {
	const { logger } = ctx;
	const { fullCustomer, trialContext } = billingContext;

	// The processor subscription the customer is on, from the customer product.
	const customerProduct =
		billingContext.currentCustomerProduct ?? billingContext.customerProduct;
	const processorSubscriptionId = customerProduct?.subscription_ids?.[0];

	if (!processorSubscriptionId) return [];

	const { isTrialing, willBeTrialing } = getTrialStateTransition({
		billingContext,
	});

	// Determine direction based on trial state change
	let direction: "charge" | "refund" | null = null;
	if (isTrialing && !willBeTrialing) {
		direction = "charge"; // Ending trial → charge for sibling products
	} else if (!isTrialing && willBeTrialing) {
		direction = "refund"; // Starting trial → refund sibling products
	}

	if (!trialContext?.appliesToBilling) return [];
	if (!direction) return [];

	const siblingCustomerProducts = getSiblingCustomerProducts({
		customerProducts: fullCustomer.customer_products,
		autumnBillingPlan,
		processorSubscriptionId,
	});

	if (siblingCustomerProducts.length === 0) return [];

	const lineItems: LineItem[] = [];
	for (const customerProduct of siblingCustomerProducts) {
		lineItems.push(
			...getLineItemsForDirection({
				ctx,
				customerProduct,
				billingContext,
				direction,
				priceFilters: { excludeOneOffPrices: true },
			}),
		);
	}

	logSharedSubscriptionTrialLineItems({
		logger,
		direction,
		siblingCustomerProducts,
		lineItems,
	});

	return lineItems;
};
