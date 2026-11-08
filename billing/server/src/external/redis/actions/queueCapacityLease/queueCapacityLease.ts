import type { Redis } from "ioredis";
import { logger } from "@/external/logtail/logtailUtils.js";
import { getMiscRedis } from "@/external/redis/initRedis.js";
import { runRedisOp } from "@/external/redis/utils/runRedisOp.js";
import { getQueueConcurrencyPolicy } from "@/queue/concurrency/getQueueConcurrencyPolicy.js";
import { generateId } from "@/utils/genUtils.js";

type QueueConcurrencyPermit = {
	release: () => Promise<void>;
};

export type LeasedQueueItem<T> = {
	item: T;
	release: () => Promise<void>;
};

export type QueueCapacityLease = {
	capacity: number;
	isLimited: boolean;
	assign: <T>(items: T[]) => Promise<LeasedQueueItem<T>[]>;
	release: () => Promise<void>;
};

const releaseImmediately = () => Promise.resolve();

// Pollers hit this on every batch while Redis is down — throttle the warn.
const CAPACITY_FAIL_OPEN_WARN_INTERVAL_MS = 30_000;
let lastCapacityFailOpenWarnAt = 0;

const logCapacityLeaseFailOpen = (error: unknown) => {
	const now = Date.now();
	if (now - lastCapacityFailOpenWarnAt < CAPACITY_FAIL_OPEN_WARN_INTERVAL_MS)
		return;
	lastCapacityFailOpenWarnAt = now;
	logger.warn("[queue-capacity] redis unavailable, failing open to unlimited", {
		type: "queue_capacity_fail_open",
		error,
	});
};

const releasePermits = async (permits: QueueConcurrencyPermit[]) => {
	await Promise.allSettled(permits.map((permit) => permit.release()));
};

const createPermit = ({
	redis,
	redisKey,
	token,
}: {
	redis: Redis;
	redisKey: string;
	token: string;
}): QueueConcurrencyPermit => {
	let released = false;

	return {
		release: async () => {
			if (released) return;
			released = true;

			try {
				await runRedisOp({
					source: "queue-concurrency:release",
					redisInstance: redis,
					operation: () => redis.releaseQueuePermit(redisKey, token),
				});
			} catch {
				// The permit lease expires automatically if Redis cannot release it.
			}
		},
	};
};

const createUnlimitedLease = ({
	requested,
}: {
	requested: number;
}): QueueCapacityLease => ({
	capacity: requested,
	isLimited: false,
	assign: async <T>(items: T[]) =>
		items.map((item) => ({
			item,
			release: releaseImmediately,
		})),
	release: releaseImmediately,
});

const createLimitedLease = ({
	permits,
}: {
	permits: QueueConcurrencyPermit[];
}): QueueCapacityLease => ({
	capacity: permits.length,
	isLimited: true,
	assign: async <T>(items: T[]) => {
		await releasePermits(permits.slice(items.length));

		return items.map((item, index) => ({
			item,
			release: permits[index].release,
		}));
	},
	release: () => releasePermits(permits),
});

export const reserveQueueCapacity = async ({
	queueId,
	requested,
}: {
	queueId: string;
	requested: number;
}): Promise<QueueCapacityLease | null> => {
	const requestedCount = Math.max(0, Math.floor(requested));
	if (requestedCount === 0) return null;

	const policy = getQueueConcurrencyPolicy({ queueId });
	if (!policy) return createUnlimitedLease({ requested: requestedCount });

	const acquiredAt = Date.now();
	const tokens = Array.from({ length: requestedCount }, () =>
		generateId("queue_permit"),
	);

	try {
		const redis = getMiscRedis();
		const result = await runRedisOp({
			source: "queue-concurrency:acquire",
			redisInstance: redis,
			operation: () =>
				redis.acquireQueuePermits(
					policy.redisKey,
					acquiredAt,
					acquiredAt + policy.leaseMs,
					policy.maxConcurrentMessages,
					requestedCount,
					...tokens,
				),
		});
		const acquiredResult = Number(result);
		if (!Number.isFinite(acquiredResult)) {
			return createUnlimitedLease({ requested: requestedCount });
		}

		const acquired = Math.max(0, Math.min(requestedCount, acquiredResult));
		if (acquired === 0) return null;

		const permits = tokens
			.slice(0, acquired)
			.map((token) =>
				createPermit({ redis, redisKey: policy.redisKey, token }),
			);
		return createLimitedLease({ permits });
	} catch (error) {
		// Fail open to normal SQS capacity so Redis cannot stop queue
		// processing. This is a throughput cap, not a correctness guard —
		// deductions stay serialized by the Lua script regardless — so it
		// fails open even under DEP_FAILURE_POLICY=fail_closed. The warn
		// keeps the outage visible in logs/metrics.
		logCapacityLeaseFailOpen(error);
		return createUnlimitedLease({ requested: requestedCount });
	}
};
