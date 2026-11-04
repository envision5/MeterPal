import { type FullCusProduct } from "@autumn/shared";

/**
 * The distinct processor subscription ids a set of customer products is on.
 */
export const customerProductsToProcessorSubscriptionIds = ({
	customerProducts,
}: {
	customerProducts: FullCusProduct[];
}): string[] => {
	const ids = customerProducts.flatMap(
		(customerProduct) => customerProduct.subscription_ids ?? [],
	);
	return [...new Set(ids)];
};

/**
 * Filter customer products by processor subscription id. When no subscription id
 * is given, returns the products that aren't on any subscription.
 */
export const filterCustomerProductsByProcessorSubscriptionId = ({
	customerProducts,
	processorSubscriptionId,
}: {
	customerProducts: FullCusProduct[];
	processorSubscriptionId?: string;
}): FullCusProduct[] => {
	return customerProducts.filter((customerProduct) =>
		processorSubscriptionId
			? customerProduct.subscription_ids?.includes(processorSubscriptionId)
			: !customerProduct.subscription_ids?.length,
	);
};
