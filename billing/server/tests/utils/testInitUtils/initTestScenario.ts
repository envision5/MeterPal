import { ApiVersion, type CustomerData, type ProductV2 } from "@autumn/shared";
import { AutumnInt } from "@/external/autumn/autumnCli.js";
import ctx from "./createTestContext.js";
import { initTestCustomer } from "./initTestCustomer.js";
import { initTestProducts } from "./initTestProducts.js";

/**
 * Initialize a complete test scenario with customer, products, and optional attachment.
 * Combines initTestCustomer, initTestProducts, and attach into a single call.
 *
 * @param customerId - Unique identifier used as customerId and product prefix
 * @param products - Array of products to create (use constructProduct)
 * @param attachProducts - Array of product IDs to attach to customer
 * @param customerOptions - Customer initialization options
 */
export const initTestScenario = async ({
	customerId,
	products,
	attachProducts,
	customerOptions = {},
}: {
	customerId: string;
	products: ProductV2[];
	attachProducts?: string[];
	customerOptions?: {
		customerData?: CustomerData;
		withDefault?: boolean;
	};
}) => {
	const { customerData, withDefault = false } = customerOptions;

	// 1. Initialize customer
	const { customer } = await initTestCustomer({
		ctx,
		customerId,
		customerData,
		withDefault,
	});

	// 2. Initialize products (prefix = customerId for isolation)
	await initTestProducts({
		ctx,
		products,
		prefix: customerId,
	});

	// 3. Create autumn clients
	const autumnV1 = new AutumnInt({
		version: ApiVersion.V1_2,
		secretKey: ctx.orgSecretKey,
	});

	const autumnV2 = new AutumnInt({
		version: ApiVersion.V2_0,
		secretKey: ctx.orgSecretKey,
	});

	// 4. Attach products if requested (prefix IDs to match mutated products)
	if (attachProducts && attachProducts.length > 0) {
		for (const productId of attachProducts) {
			const prefixedId = `${customerId}_${productId}`;
			await autumnV1.attach({
				customer_id: customerId,
				product_id: prefixedId,
			});
		}
	}

	return {
		customerId,
		products,
		autumnV1,
		autumnV2,
		customer,
		ctx,
	};
};
