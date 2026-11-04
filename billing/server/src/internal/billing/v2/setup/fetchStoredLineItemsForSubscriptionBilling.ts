import type { FullCustomer } from "@autumn/shared";
import type { DrizzleCli } from "@/db/initDrizzle";
import { fetchStoredLineItemsForBilling } from "./fetchStoredLineItemsForBilling";
import { getSiblingCusProductIds } from "./getSiblingCusProductIds";

export const fetchStoredLineItemsForSubscriptionBilling = async ({
	db,
	fullCustomer,
	processorSubscriptionId,
	outgoingCusProductIds,
}: {
	db: DrizzleCli;
	fullCustomer: FullCustomer;
	processorSubscriptionId?: string;
	outgoingCusProductIds: string[];
}) => {
	const siblingIds = getSiblingCusProductIds({
		fullCustomer,
		processorSubscriptionId,
		excludeIds: outgoingCusProductIds,
	});
	return fetchStoredLineItemsForBilling({
		db,
		customerProductIds: [...outgoingCusProductIds, ...siblingIds],
	});
};
