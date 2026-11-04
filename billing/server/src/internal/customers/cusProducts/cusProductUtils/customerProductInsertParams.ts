import {
	type Customer,
	type Entity,
	type FreeTrial,
	type FullCustomer,
	type FullProduct,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { InsertCusProductParams } from "../AttachParams.js";
import { newCusToFullCus } from "../../cusUtils/cusUtils.js";

/**
 * Builds the params needed to insert a customer product for a given product.
 *
 * Used when the customer product is created directly (not through the attach
 * flow) — e.g. scheduling a default product after a cancellation.
 */
export const productToInsertParams = ({
	ctx,
	fullCus,
	newProduct,
	entities,
}: {
	ctx: AutumnContext;
	fullCus: FullCustomer;
	newProduct: FullProduct;
	entities?: Entity[];
}): InsertCusProductParams => {
	const { org, features } = ctx;
	const params: InsertCusProductParams = {
		customer: fullCus,
		org,
		product: newProduct,
		prices: newProduct.prices,
		entitlements: newProduct.entitlements,
		features,
		cusProducts: fullCus.customer_products,
		freeTrial: null,
		optionsList: [],
		internalEntityId: fullCus.entity?.internal_id ?? undefined,
		entityId: fullCus.entity?.id ?? undefined,
		entities: entities || [],
		replaceables: [],
	};

	return params;
};

/** Same as `productToInsertParams`, for a customer that was just created. */
export const newCusToInsertParams = ({
	ctx,
	newCus,
	product,
	freeTrial = null,
}: {
	ctx: AutumnContext;
	newCus: Customer;
	product: FullProduct;
	freeTrial?: FreeTrial | null;
}) => {
	const { org } = ctx;
	return {
		req: ctx,
		org,
		customer: newCusToFullCus({ newCus }),
		product,
		prices: product.prices,
		entitlements: product.entitlements,
		replaceables: [],
		freeTrial,
		optionsList: [],
		cusProducts: [],
		entities: [],
		features: [],
	} satisfies InsertCusProductParams;
};
