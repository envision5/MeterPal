/** The exactly-once mechanism the cron guards rely on: a status-conditioned
 *  claim UPDATE matches exactly one concurrent caller — the loser matches
 *  zero rows (and therefore runs no side effects), while the row's status and
 *  updated_at are left untouched for the loser. Covers
 *  CusProductService.update({ inStatuses }) and the
 *  batchUpdateCustomerProducts inStatuses pass-through. */

import { expect, test } from "bun:test";
import {
	CusProductStatus,
	customerProducts,
	customers,
} from "@autumn/shared";
import { items } from "@tests/utils/fixtures/items.js";
import { products } from "@tests/utils/fixtures/products.js";
import { initScenario, s } from "@tests/utils/testInitUtils/initScenario.js";
import chalk from "chalk";
import { and, eq } from "drizzle-orm";
import { logger } from "@/external/logtail/logtailUtils";
import { resolveRedisV2 } from "@/external/redis/resolveRedisV2.js";
import { CusProductService, ACTIVE_STATUSES } from "@/internal/customers/cusProducts/CusProductService";
import { batchUpdateCustomerProducts } from "@/internal/customers/cusProducts/repos/batchUpdateCustomerProducts.js";

test(
	`${chalk.yellowBright("product-cron: status-conditioned claim matches exactly once")}`,
	async () => {
		const customerId = "expiry-claim-guard";
		const trialProd = products.base({
			id: "expiry-claim-guard-prod",
			items: [items.monthlyMessages({ includedUsage: 100 })],
		});

		const { ctx } = await initScenario({
			customerId,
			setup: [s.customer({ testClock: false }), s.products({ list: [trialProd] })],
			actions: [s.billing.attach({ productId: trialProd.id })],
		});

		const [customer] = await ctx.db
			.select({ internalId: customers.internal_id })
			.from(customers)
			.where(
				and(
					eq(customers.id, customerId),
					eq(customers.org_id, ctx.org.id),
					eq(customers.env, ctx.env),
				),
			);
		expect(customer).toBeDefined();

		const [cusProduct] = await ctx.db
			.select({ id: customerProducts.id, updatedAt: customerProducts.updated_at })
			.from(customerProducts)
			.where(
				and(
					eq(customerProducts.internal_customer_id, customer.internalId),
					eq(customerProducts.product_id, trialProd.id),
				),
			);
		expect(cusProduct).toBeDefined();

		const repoCtx = {
			db: ctx.db,
			org: ctx.org,
			env: ctx.env,
			logger,
			redisV2: resolveRedisV2(),
		} as Parameters<typeof CusProductService.update>[0]["ctx"];

		// First claim flips the row out of the active statuses and wins.
		const firstClaim = await CusProductService.update({
			ctx: repoCtx,
			cusProductId: cusProduct.id,
			updates: { status: CusProductStatus.Expired },
			inStatuses: ACTIVE_STATUSES,
		});
		expect(firstClaim.length).toBe(1);

		const [afterFirst] = await ctx.db
			.select({ status: customerProducts.status, updatedAt: customerProducts.updated_at })
			.from(customerProducts)
			.where(eq(customerProducts.id, cusProduct.id));
		expect(afterFirst.status).toBe(CusProductStatus.Expired);

		// A concurrent duplicate (stale read, row already expired) matches
		// nothing and leaves the row untouched.
		const secondClaim = await CusProductService.update({
			ctx: repoCtx,
			cusProductId: cusProduct.id,
			updates: { status: CusProductStatus.Expired },
			inStatuses: ACTIVE_STATUSES,
		});
		expect(secondClaim.length).toBe(0);

		const [afterSecond] = await ctx.db
			.select({ status: customerProducts.status, updatedAt: customerProducts.updated_at })
			.from(customerProducts)
			.where(eq(customerProducts.id, cusProduct.id));
		expect(afterSecond.status).toBe(CusProductStatus.Expired);
		expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
	},
);

test(
	`${chalk.yellowBright("product-cron: batch update with inStatuses no-ops on already-expired rows")}`,
	async () => {
		const customerId = "expiry-claim-guard-batch";
		const prod = products.base({
			id: "expiry-claim-guard-batch-prod",
			items: [items.monthlyMessages({ includedUsage: 100 })],
		});

		const { ctx } = await initScenario({
			customerId,
			setup: [s.customer({ testClock: false }), s.products({ list: [prod] })],
			actions: [s.billing.attach({ productId: prod.id })],
		});

		const [customer] = await ctx.db
			.select({ internalId: customers.internal_id })
			.from(customers)
			.where(
				and(
					eq(customers.id, customerId),
					eq(customers.org_id, ctx.org.id),
					eq(customers.env, ctx.env),
				),
			);

		const [cusProduct] = await ctx.db
			.select({ id: customerProducts.id })
			.from(customerProducts)
			.where(
				and(
					eq(customerProducts.internal_customer_id, customer.internalId),
					eq(customerProducts.product_id, prod.id),
				),
			);

		const repoCtx = {
			db: ctx.db,
			org: ctx.org,
			env: ctx.env,
			logger,
			redisV2: resolveRedisV2(),
		} as Parameters<typeof batchUpdateCustomerProducts>[0]["ctx"];

		await batchUpdateCustomerProducts({
			ctx: repoCtx,
			inStatuses: ACTIVE_STATUSES,
			updates: [
				{
					id: cusProduct.id,
					updates: { status: CusProductStatus.Expired },
				},
			],
		});

		const [expired] = await ctx.db
			.select({ status: customerProducts.status })
			.from(customerProducts)
			.where(eq(customerProducts.id, cusProduct.id));
		expect(expired.status).toBe(CusProductStatus.Expired);

		// Re-running the same batch (duplicate cron instance) is a no-op.
		await batchUpdateCustomerProducts({
			ctx: repoCtx,
			inStatuses: ACTIVE_STATUSES,
			updates: [
				{
					id: cusProduct.id,
					updates: { status: CusProductStatus.Expired },
				},
			],
		});

		const [stillExpired] = await ctx.db
			.select({ status: customerProducts.status })
			.from(customerProducts)
			.where(eq(customerProducts.id, cusProduct.id));
		expect(stillExpired.status).toBe(CusProductStatus.Expired);
	},
);
