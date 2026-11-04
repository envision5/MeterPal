import {
	type DbPrice,
	type FixedPriceConfig,
	type Price,
	type Product,
	prices,
	type UsagePriceConfig,
} from "@autumn/shared";
import { buildConflictUpdateColumns } from "@server/db/dbUtils";
import type { DrizzleCli } from "@server/db/initDrizzle";
import { and, eq, inArray } from "drizzle-orm";

export class PriceService {
	static async get({ db, id }: { db: DrizzleCli; id: string }) {
		return (await db.query.prices.findFirst({
			where: eq(prices.id, id),
		})) as Price;
	}

	static async getCustomInEntIds({
		db,
		entitlementIds,
	}: {
		db: DrizzleCli;
		entitlementIds: string[];
	}) {
		return await db.query.prices.findMany({
			where: and(
				inArray(prices.entitlement_id, entitlementIds),
				eq(prices.is_custom, true),
			),
		});
	}

	static async getInIds({ db, ids }: { db: DrizzleCli; ids: string[] }) {
		if (!ids || ids.length === 0) {
			return [];
		}

		return (await db.query.prices.findMany({
			where: inArray(prices.id, ids),
			with: {
				product: true,
			},
		})) as (Price & { product: Product })[];
	}

	static async insert({ db, data }: { db: DrizzleCli; data: Price | Price[] }) {
		if (Array.isArray(data) && data.length === 0) {
			return;
		}

		await db.insert(prices).values(data as any);
	}

	static async update({
		db,
		id,
		update,
	}: {
		db: DrizzleCli;
		id: string;
		update: Partial<DbPrice>;
	}) {
		await db.update(prices).set(update).where(eq(prices.id, id));
	}

	static async upsert({ db, data }: { db: DrizzleCli; data: Price | Price[] }) {
		if (Array.isArray(data) && data.length === 0) return;

		const updateColumns = buildConflictUpdateColumns(prices, ["id"]);

		await db
			.insert(prices)
			.values(data as any)
			.onConflictDoUpdate({
				target: prices.id,
				set: updateColumns,
			});
	}

	static async deleteInIds({ db, ids }: { db: DrizzleCli; ids: string[] }) {
		await db.delete(prices).where(inArray(prices.id, ids));
	}

	static async retireInIds({ db, ids }: { db: DrizzleCli; ids: string[] }) {
		if (ids.length === 0) return;
		await db
			.update(prices)
			.set({ is_custom: true })
			.where(inArray(prices.id, ids));
	}

	static async updateConfig({
		db,
		id,
		config,
	}: {
		db: DrizzleCli;
		id: string;
		config: FixedPriceConfig | UsagePriceConfig;
	}) {
		const curPrice = await PriceService.get({ db, id });
		const newConfig = {
			...curPrice.config,
			...config,
		};
		await db.update(prices).set({ config: newConfig }).where(eq(prices.id, id));
	}
}
