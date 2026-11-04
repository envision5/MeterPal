import { ErrCode, type Subscription, subscriptions } from "@autumn/shared";
import type { DrizzleCli } from "@server/db/initDrizzle.js";
import RecaseError from "@server/utils/errorUtils.js";
import { eq, inArray } from "drizzle-orm";

export class SubService {
	static async createSub({ db, sub }: { db: DrizzleCli; sub: Subscription }) {
		const data = await db.insert(subscriptions).values(sub).returning();

		if (data.length === 0) {
			throw new RecaseError({
				code: ErrCode.InsertSubscriptionFailed,
				message: "Failed to create subscription",
				statusCode: 500,
			});
		}

		return data[0] as Subscription;
	}

	/**
	 * Insert, or return null when a concurrent writer already claimed the
	 * processor id. Callers that check-then-insert must handle the null by
	 * re-reading — two webhooks for one subscription arrive in parallel.
	 */
	static async createSubIfAbsent({
		db,
		sub,
	}: {
		db: DrizzleCli;
		sub: Subscription;
	}): Promise<Subscription | null> {
		const data = await db
			.insert(subscriptions)
			.values(sub)
			.onConflictDoNothing()
			.returning();

		return (data[0] as Subscription | undefined) ?? null;
	}

	static async update({
		db,
		subscriptionId,
		updates,
	}: {
		db: DrizzleCli;
		subscriptionId: string;
		updates: Partial<Subscription>;
	}) {
		return await db
			.update(subscriptions)
			.set(updates)
			.where(eq(subscriptions.id, subscriptionId))
			.returning();
	}

	static async getInProcessorIds({
		db,
		ids,
	}: {
		db: DrizzleCli;
		ids: string[];
	}) {
		return (await db
			.select()
			.from(subscriptions)
			.where(inArray(subscriptions.processor_id, ids))) as Subscription[];
	}

	static async getByProcessorId({
		db,
		processorId,
	}: {
		db: DrizzleCli;
		processorId: string;
	}) {
		return await db.query.subscriptions.findFirst({
			where: eq(subscriptions.processor_id, processorId),
		});
	}

	static async upsertByProcessorId({
		db,
		subscription,
	}: {
		db: DrizzleCli;
		subscription: Subscription;
	}) {
		// 1. Get by processor ID
		const existingSub = await SubService.getByProcessorId({
			db,
			processorId: subscription.processor_id ?? "",
		});

		const periodUpdates = {
			current_period_start: subscription.current_period_start,
			current_period_end: subscription.current_period_end,
			billing_cycle_anchor_seconds: subscription.billing_cycle_anchor_seconds,
		};

		if (existingSub) {
			return await SubService.update({
				db,
				subscriptionId: existingSub.id,
				updates: periodUpdates,
			});
		}

		const createdSub = await SubService.createSubIfAbsent({
			db,
			sub: subscription,
		});

		if (createdSub) return createdSub;

		// A concurrent webhook inserted it between the read and the write.
		const winningSub = await SubService.getByProcessorId({
			db,
			processorId: subscription.processor_id ?? "",
		});

		if (!winningSub) {
			throw new RecaseError({
				code: ErrCode.InsertSubscriptionFailed,
				message: "Failed to create subscription",
				statusCode: 500,
			});
		}

		return await SubService.update({
			db,
			subscriptionId: winningSub.id,
			updates: periodUpdates,
		});
	}
}
