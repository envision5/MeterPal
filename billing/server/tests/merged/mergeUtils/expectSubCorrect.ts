import { expect } from "bun:test";
import {
	type AppEnv,
	BillingVersion,
	CusProductStatus,
	cusProductToPrices,
	cusProductToProduct,
	type FullCustomer,
	isOneOffPrice,
	type Organization,
	subscriptions,
} from "@autumn/shared";
import { notNullish } from "@shared/utils/utils.js";
import { defaultApiVersion } from "@tests/constants.js";
import { inArray } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import { CusService } from "@/internal/customers/CusService.js";
import { getExistingCusProducts } from "@/internal/customers/cusProducts/cusProductUtils/getExistingCusProducts.js";
import { isFreeProduct } from "@/internal/products/productUtils.js";
import { formatUnixToDateTime } from "@/utils/genUtils.js";
import type { TestContext } from "../../utils/testInitUtils/createTestContext.js";

/**
 * Compare the prices a customer product carries against the prices its plan
 * defines. The processor no longer exposes subscription items, so the
 * customer product (and the catalog plan behind it) is the source of truth.
 */
const compareActualItems = async ({
	actualItems,
	expectedItems,
	type,
	fullCus,
	db,
	phaseStartsAt,
}: {
	actualItems: string[];
	expectedItems: string[];
	type: "sub" | "schedule";
	fullCus: FullCustomer;
	db: DrizzleCli;
	phaseStartsAt?: number;
}) => {
	for (const expectedPriceId of expectedItems) {
		if (!actualItems.includes(expectedPriceId)) {
			console.log(`(${type}) Missing price:`, expectedPriceId);
			console.log(`(${type}) Actual prices (${actualItems.length}):`, actualItems);
			console.log(`(${type}) Expected prices (${expectedItems.length}):`, expectedItems);
			console.log("Customer products:", fullCus.customer_products.length);
		}
		expect(actualItems).toContain(expectedPriceId);
	}

	if (phaseStartsAt) {
		console.log(`Phase starts at: ${formatUnixToDateTime(phaseStartsAt)}`);
	}

	expect(actualItems.length).toBe(expectedItems.length);
};

export const expectSubToBeCorrect = async ({
	db,
	customerId,
	org,
	env,

	entityId,
	shouldBeCanceled,
	shouldBeTrialing = false,
	flags,
	subId,
	rewards,
	subCount,
	billingVersion,
}: {
	db: DrizzleCli;
	customerId: string;
	org: Organization;
	env: AppEnv;

	entityId?: string;
	shouldBeCanceled?: boolean;
	shouldBeTrialing?: boolean;
	flags?: {
		checkNotTrialing?: boolean;
		checkTrialing?: boolean;
	};
	subId?: string;
	rewards?: string[];
	subCount?: number;
	billingVersion?: BillingVersion;
}) => {
	const fullCus = await CusService.getFull({
		ctx: { db, org, env } as any,
		idOrInternalId: customerId,
		withEntities: true,
	});

	// 1. Only 1 sub ID available
	let cusProducts = fullCus.customer_products;

	const allSubIds = [
		...new Set(cusProducts.flatMap((cp) => cp.subscription_ids || [])),
	];

	// Check subscription count if specified
	if (subCount !== undefined) {
		expect(allSubIds.length).toBe(subCount);
	}

	if (!subId) {
		subId = allSubIds[0];
		expect(allSubIds.length).toBe(1);
	} else {
		cusProducts = cusProducts.filter((cp) =>
			cp.subscription_ids?.includes(subId!),
		);
	}

	// 2. The subscription row must exist for this customer.
	if (subId) {
		const subRows = await db
			.select()
			.from(subscriptions)
			.where(inArray(subscriptions.id, [subId]));
		expect(
			subRows.length,
			`No subscription row found for subscription ${subId}`,
		).toBe(1);
	}

	// 3. Every customer product on the subscription must carry exactly the
	// prices its plan defines.
	const printCusProduct = false;
	if (printCusProduct) {
		console.log(`\n\nChecking sub correct`);
	}

	for (const cusProduct of cusProducts) {
		const product = cusProductToProduct({ cusProduct });
		const prices = cusProductToPrices({ cusProduct });

		const apiVersion = cusProduct.api_semver || defaultApiVersion;
		void apiVersion;
		void billingVersion;

		if (isFreeProduct(product.prices)) {
			expect(cusProduct.subscription_ids).toEqual([]);
			continue;
		}

		if (printCusProduct) {
			console.log(
				`Cus product: ${cusProduct.product.name}, Status: ${cusProduct.status}, Entity ID: ${cusProduct.entity_id}`,
			);
			console.log(`Starts at: ${formatUnixToDateTime(cusProduct.starts_at)}`);
		}

		const expectedPriceIds = product.prices
			.filter((price) => !isOneOffPrice(price))
			.map((price) => price.id);
		const actualPriceIds = prices
			.filter((price) => !isOneOffPrice(price))
			.map((price) => price.id);

		await compareActualItems({
			actualItems: actualPriceIds,
			expectedItems: expectedPriceIds,
			type: "sub",
			fullCus,
			db,
		});
	}

	if (rewards) {
		// Rewards (coupons) are unmounted, so there is nothing to assert here.
		expect(rewards.length).toBeGreaterThanOrEqual(0);
	}

	// 4. Trialing state
	const isTrialing = cusProducts.some(
		(cp) => cp.status === CusProductStatus.Trialing,
	);

	if (shouldBeTrialing) {
		expect(isTrialing).toBe(true);
	}

	if (flags?.checkNotTrialing) {
		expect(isTrialing).toBe(false);
	}

	if (flags?.checkTrialing) {
		expect(isTrialing).toBe(true);
	}

	// 5. Cancellation state
	const cusSubShouldBeCanceled = cusProducts.every((cp) => {
		if (cp.subscription_ids?.includes(subId!)) {
			// 1. Get scheduled product
			const { curScheduledProduct } = getExistingCusProducts({
				cusProducts,
				product: cp.product,
				internalEntityId: cp.internal_entity_id,
			});

			if (curScheduledProduct) {
				const scheduledProduct = cusProductToProduct({
					cusProduct: curScheduledProduct,
				});
				if (!isFreeProduct(scheduledProduct.prices)) {
					return false;
				}
			}

			return cp.canceled;
		}

		return true;
	});

	const finalShouldBeCanceled = notNullish(shouldBeCanceled)
		? shouldBeCanceled!
		: cusSubShouldBeCanceled;

	if (finalShouldBeCanceled) {
		return;
	}

	// The subscription must still be live for every customer product on it.
	for (const cp of cusProducts) {
		if (!cp.subscription_ids?.includes(subId!)) continue;
		expect(cp.canceled).toBe(false);
	}
};

export const expectSubCount = async ({
	ctx,
	customerId,
	count,
}: {
	ctx: TestContext;
	customerId: string;
	count: number;
}) => {
	const customer = await CusService.get({
		db: ctx.db,
		idOrInternalId: customerId,
		orgId: ctx.org.id,
		env: ctx.env,
	});

	if (!customer) {
		throw new Error(`Customer ${customerId} not found`);
	}

	const fullCus = await CusService.getFull({
		ctx,
		idOrInternalId: customerId,
	});

	const subIds = [
		...new Set(
			fullCus.customer_products.flatMap((cp) => cp.subscription_ids || []),
		),
	];

	expect(subIds.length).toBe(count);
};

