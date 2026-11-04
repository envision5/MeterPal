import { ApiVersion, type ProductV2 } from "@autumn/shared";
import type { TestContext } from "@tests/utils/testInitUtils/createTestContext.js";
import { createProducts } from "@tests/utils/productUtils.js";
import { addPrefixToProducts } from "@tests/utils/testProductUtils/testProductUtils.js";
import { AutumnInt } from "@/external/autumn/autumnCli.js";

/**
 * Create products for a test scenario through the Autumn API.
 *
 * Processor-neutral replacement for the old `initTestProducts` harness: products
 * are created through the org's secret key and no processor-side resources are
 * provisioned.
 */
export const initTestProducts = async ({
	ctx,
	products,
	prefix,
	skipPrefixIds = [],
	customerId,
	customerIds,
}: {
	ctx: TestContext;
	products: ProductV2[];
	prefix?: string;
	skipPrefixIds?: string[];
	customerId?: string;
	customerIds?: string[];
}) => {
	// 1. Add prefix to products (except those in skipPrefixIds)
	if (prefix) {
		const productsToPrefix = products.filter(
			(p) => !skipPrefixIds.includes(p.id),
		);
		addPrefixToProducts({
			products: productsToPrefix,
			prefix,
		});
	}

	// 2. Create products using the org's secret key
	const autumn = new AutumnInt({
		version: ApiVersion.V1_2,
		secretKey: ctx.orgSecretKey,
	});

	if (customerIds) {
		for (const id of customerIds) {
			try {
				await autumn.customers.delete(id);
			} catch {}
		}
	}
	if (customerId) {
		try {
			await autumn.customers.delete(customerId);
		} catch {}
	}

	await createProducts({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		autumn: autumn,
		products,
	});
};
