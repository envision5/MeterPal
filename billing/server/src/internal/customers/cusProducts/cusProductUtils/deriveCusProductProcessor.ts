import { type FullCusProduct, ProcessorType } from "@autumn/shared";

/**
 * `customer_products.processor` no longer exists as a column — the API-level
 * `{ type, id }` shape is derived from the product's processor subscription ids
 * instead. PayPal is the only processor, so the type is always PayPal.
 */
export const deriveCusProductProcessor = (
	cusProduct: FullCusProduct,
): { type: ProcessorType; id: string | null } | null => {
	const id = cusProduct.subscription_ids?.[0];
	if (!id) return null;

	return { type: ProcessorType.PayPal, id };
};

/** Returns the customer products with their derived `processor` attached. */
export const withDerivedCusProductProcessors = (
	cusProducts: FullCusProduct[],
): FullCusProduct[] =>
	cusProducts.map((cusProduct) => ({
		...cusProduct,
		processor: deriveCusProductProcessor(cusProduct),
	}));
