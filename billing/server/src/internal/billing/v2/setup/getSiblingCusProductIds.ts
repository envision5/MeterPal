import { cp, type FullCustomer } from "@autumn/shared";

export const getSiblingCusProductIds = ({
	fullCustomer,
	processorSubscriptionId,
	excludeIds = [],
}: {
	fullCustomer: FullCustomer;
	processorSubscriptionId?: string;
	excludeIds?: string[];
}): string[] => {
	if (!processorSubscriptionId) return [];

	const excluded = new Set(excludeIds);

	return fullCustomer.customer_products
		.filter(
			(cusProduct) =>
				!excluded.has(cusProduct.id) &&
				cp(cusProduct).paid().recurring().onProcessorSubscription({
					processorSubscriptionId,
				}).valid,
		)
		.map((cusProduct) => cusProduct.id);
};
