import {
	ACTIVE_STATUSES,
	customerPrices,
	customerProducts,
	type Price,
	PriceType,
	prices,
} from "@autumn/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle";

/** A base price is a fixed price that isn't attached to an entitlement. */
const composeBasePriceCondition = () =>
	and(
		isNull(prices.entitlement_id),
		sql`${prices.config} ->> 'type' = ${PriceType.Fixed}`,
	);

/**
 * The distinct base prices a customer license link currently resolves to.
 * Used to size a batch transition before it runs.
 */
export const listDistinctBasePricesByCustomerLicense = async ({
	db,
	customerLicenseLinkId,
	limit,
}: {
	db: DrizzleCli;
	customerLicenseLinkId: string;
	limit: number;
}): Promise<Price[]> => {
	const rows = await db
		.selectDistinct({ price: prices })
		.from(customerPrices)
		.innerJoin(
			customerProducts,
			eq(customerPrices.customer_product_id, customerProducts.id),
		)
		.innerJoin(prices, eq(customerPrices.price_id, prices.id))
		.where(
			and(
				eq(customerProducts.customer_license_link_id, customerLicenseLinkId),
				inArray(customerProducts.status, ACTIVE_STATUSES),
				composeBasePriceCondition(),
			),
		)
		.orderBy(asc(prices.id))
		.limit(limit);

	return rows.map(({ price }) => price) as Price[];
};
