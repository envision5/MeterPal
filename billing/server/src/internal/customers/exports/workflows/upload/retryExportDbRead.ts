import type { Logger } from "@/external/logtail/logtailUtils.js";
import { retryBoundedAsync } from "@/utils/retryBoundedAsync.js";

export type CustomerLimits = {
	timeoutMs: number;
	attempts: number;
	retryDelayMs: number;
	maxRetryDelayMs: number;
};

/** Each verification needs a replica connection, so throughput plateaus at
 *  roughly twice REPLICA_DB_POOL_MAX and extra slots only queue. Measured
 *  against prod's pool of 5: 113ms/customer at 5, 82ms at 8, 80ms at 10 and
 *  flat thereafter. Raising the replica pool is what moves this further. */
export const customerExportDbReadLimits: CustomerLimits = {
	timeoutMs: 30_000,
	attempts: 6,
	retryDelayMs: 2_000,
	maxRetryDelayMs: 30_000,
};

/** A page read that throws aborts the generator and restarts the whole export,
 * so these are retried on the same budget as a customer's own verification.
 * Every failure retries: a pooled connection that comes back dead rejects
 * immediately, and nothing underneath a query has already retried it. */
export const retryExportDbRead =
	<Params, Result>({
		logger,
		operation,
		query,
		limits,
	}: {
		logger: Logger;
		operation: string;
		query: (params: Params) => Promise<Result>;
		limits?: Partial<CustomerLimits>;
	}) =>
	(params: Params): Promise<Result> => {
		const { timeoutMs, attempts, retryDelayMs, maxRetryDelayMs } = {
			...customerExportDbReadLimits,
			...limits,
		};

		return retryBoundedAsync({
			attempts,
			delayMs: retryDelayMs,
			maxDelayMs: maxRetryDelayMs,
			timeoutMs,
			timeoutMessage: `${operation} timed out after ${timeoutMs}ms`,
			shouldRetry: () => true,
			run: () => query(params),
			onRetry: ({ attempt, error }) =>
				logger.warn("customer-export: retrying db read", {
					data: {
						operation,
						attempt,
						error: error instanceof Error ? error.message : String(error),
					},
				}),
		});
	};
