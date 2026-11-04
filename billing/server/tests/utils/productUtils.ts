import {
	type AppEnv,
	customerProducts,
	planLicenses,
} from "@autumn/shared";
import { eq, inArray, or } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import type { AutumnInt } from "@/external/autumn/autumnCli.js";
import { ProductService } from "@/internal/products/ProductService.js";

export const createProduct = async ({
	db,
	orgId,
	env,
	autumn,
	product,
	prefix,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
	autumn: AutumnInt;
	product: any;
	prefix?: string;
}) => {
	try {
		const products = await ProductService.listFull({
			db,
			orgId,
			env,
			returnAll: true,
			inIds: [product.id],
		});

		// customer_products_internal_product_id_fkey has no ON DELETE CASCADE.
		// Wipe referencing rows first so the product delete succeeds.
		for (const prod of products) {
			await db
				.delete(customerProducts)
				.where(eq(customerProducts.internal_product_id, prod.internal_id));
		}

		// license_entitlements/license_prices RESTRICT their item rows; drop
		// plan_license first so the product delete can cascade items freely.
		const internalIds = products.map((prod) => prod.internal_id);
		if (internalIds.length > 0) {
			await db
				.delete(planLicenses)
				.where(
					or(
						inArray(planLicenses.parent_internal_product_id, internalIds),
						inArray(planLicenses.license_internal_product_id, internalIds),
					),
				);
		}

		const batchDelete = [];
		for (const prod of products) {
			batchDelete.push(
				ProductService.deleteByInternalId({
					db,
					internalId: prod.internal_id,
					orgId,
					env,
				}),
			);
		}

		await Promise.all(batchDelete);
	} catch (error) {
		console.error("Error deleting product", error);
		// Ignore deletion errors (might have customers attached)
	}

	const clone = structuredClone(product);
	if (typeof clone.items === "object") {
		clone.items = Object.values(clone.items);
	}

	if (prefix) {
		clone.id = `${prefix}_${clone.id}`;
		clone.name = `${clone.name} ${prefix}`;
	}

	try {
		await autumn.products.create(clone);
	} catch (error: any) {
		// If product already exists (race condition), silently continue
		if (
			error?.message?.includes("already exists") ||
			error?.message?.includes("duplicate") ||
			error?.code === "PRODUCT_EXISTS"
		) {
			return;
		}
		throw error;
	}
};

export const createProducts = async ({
	db,
	orgId,
	env,
	autumn,
	products,
	prefix,
	customerId,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
	autumn: AutumnInt;
	products: any[];
	prefix?: string;
	customerId?: string;
}) => {
	if (customerId) {
		try {
			await autumn.customers.delete(customerId);
		} catch (error) {}
	}

	const batchCreate = [];
	for (const product of products) {
		batchCreate.push(
			createProduct({
				db,
				orgId,
				env,
				autumn,
				product,
				prefix,
			}),
		);
	}

	await Promise.all(batchCreate);
};
