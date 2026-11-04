import {
	type AppEnv,
	customerProducts,
	type FullCusProduct,
} from "@autumn/shared";
import { arrayContains } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle";

/** Finds customer products whose subscription_ids contain the given processor subscription ID. */
export const getByProcessorSubId = async ({
	db,
	processorSubId,
	orgId,
	env,
	inStatuses,
}: {
	db: DrizzleCli;
	processorSubId: string;
	orgId: string;
	env: AppEnv;
	inStatuses?: string[];
}): Promise<FullCusProduct[]> => {
	const data = await db.query.customerProducts.findMany({
		where: (_table, { and: dAnd, inArray: dInArray }) =>
			dAnd(
				arrayContains(customerProducts.subscription_ids, [processorSubId]),
				inStatuses ? dInArray(customerProducts.status, inStatuses) : undefined,
			),
		with: {
			product: true,
			customer: true,
			customer_entitlements: {
				with: {
					entitlement: {
						with: {
							feature: true,
						},
					},
					replaceables: true,
					rollovers: true,
				},
			},
			customer_prices: {
				with: {
					price: true,
				},
			},
			free_trial: true,
		},
	});

	const cusProducts = data as FullCusProduct[];

	return cusProducts.filter((cusProduct) => {
		if (!cusProduct.product) return false;
		const product = cusProduct.product;

		if (product.org_id !== orgId || product.env !== env) {
			return false;
		}

		return true;
	});
};
