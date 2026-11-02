import { and, eq } from "drizzle-orm";
import { CusProductStatus, customerProducts, products } from "@autumn/shared";
import type { DrizzleCli } from "@/db/initDrizzle.js";

/**
 * True when the customer already holds an active customer product for the
 * given product id.
 *
 * Used by the PayPal attach path, where the plan can already be applied by
 * the time the attach runs (the PayPal activation attaches it) — the billing
 * context is a snapshot taken before that, so it cannot answer this.
 */
export const hasActiveCustomerProductForProduct = async ({
	db,
	internalCustomerId,
	productId,
}: {
	db: DrizzleCli;
	internalCustomerId: string;
	productId: string | undefined;
}): Promise<boolean> => {
	if (!internalCustomerId || !productId) return false;

	const [row] = await db
		.select({ id: customerProducts.id })
		.from(customerProducts)
		.innerJoin(
			products,
			eq(products.internal_id, customerProducts.internal_product_id),
		)
		.where(
			and(
				eq(customerProducts.internal_customer_id, internalCustomerId),
				eq(customerProducts.status, CusProductStatus.Active),
				eq(products.id, productId),
			),
		)
		.limit(1);

	return Boolean(row);
};
