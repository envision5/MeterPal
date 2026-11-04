import {
	type FullCusProduct,
	type Price,
	type UsagePriceConfig,
	isFixedPrice,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { CusService } from "@/internal/customers/CusService";
import { ProductService } from "@/internal/products/ProductService";

const priceFeatureId = (price: Price): string | null => {
	if (isFixedPrice(price)) return null;
	const config = price.config as UsagePriceConfig;
	return config.feature_id ?? null;
};

const priceMatchKey = (price: Price): string => {
	if (isFixedPrice(price)) return "__fixed__";
	const featureId = priceFeatureId(price);
	const config = price.config as UsagePriceConfig;
	const billWhen = config.bill_when ?? "<missing>";
	return `feature:${featureId ?? "<missing>"}|bill_when:${billWhen}`;
};

/**
 * Attach a customer's primary FullCusProduct (custom or otherwise) to the
 * matching catalog plan's prices via feature_id (or "fixed" for base prices).
 * Returns matched pairs and the catalog plan for further assertions.
 */
export const loadCustomerAndCatalogPrices = async ({
	ctx,
	customerId,
	catalogProductId,
}: {
	ctx: AutumnContext;
	customerId: string;
	catalogProductId: string;
}): Promise<{
	catalogPrices: Price[];
	customerPrices: Price[];
	pairs: { catalog: Price; customer: Price }[];
	cusProduct: FullCusProduct;
}> => {
	const fullCustomer = await CusService.getFull({
		ctx,
		idOrInternalId: customerId,
	});

	const cusProduct = fullCustomer.customer_products[0];
	if (!cusProduct) {
		throw new Error(`Customer ${customerId} has no customer_products`);
	}

	const fullCatalog = await ProductService.getFull({
		db: ctx.db,
		idOrInternalId: catalogProductId,
		orgId: ctx.org.id,
		env: ctx.env,
	});

	const customerPrices = cusProduct.customer_prices.map(
		(customerPrice) => customerPrice.price,
	);

	const pairs: { catalog: Price; customer: Price }[] = [];
	for (const customerPrice of customerPrices) {
		const key = priceMatchKey(customerPrice);
		const catalogMatch = fullCatalog.prices.find(
			(price) => priceMatchKey(price) === key,
		);
		if (!catalogMatch) continue;
		pairs.push({ catalog: catalogMatch, customer: customerPrice });
	}

	return {
		catalogPrices: fullCatalog.prices,
		customerPrices,
		pairs,
		cusProduct,
	};
};

export { priceMatchKey };
