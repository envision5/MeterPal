import { RecaseError } from "@autumn/shared";

/**
 * Dependency failure policy — how optional infrastructure (idempotency store,
 * distributed rate limiting, cache-backed reads) is treated when it is
 * unavailable.
 *
 *   fail_open   default — keep serving: skip the guard, bypass the limiter,
 *               answer the hot-path check. Availability over strictness. The
 *               money-moving paths stay correct regardless: deductions run
 *               through the atomic Redis Lua script or the Postgres fallback,
 *               never through an in-process decision.
 *
 *   fail_closed shed instead — 503 the request rather than serve it without
 *               the guard. For deployments where unthrottled traffic or
 *               un-deduped replays are worse than downtime.
 *
 * Set DEP_FAILURE_POLICY=fail_closed to opt in (per process / task). Queue
 * concurrency permits and worker caps always fail open — they are throughput
 * controls, not correctness guards (see queueCapacityLease.ts).
 */
export type DependencyFailurePolicy = "fail_open" | "fail_closed";

export const getDependencyFailurePolicy = (): DependencyFailurePolicy =>
	process.env.DEP_FAILURE_POLICY === "fail_closed"
		? "fail_closed"
		: "fail_open";

export const isDepFailClosed = (): boolean =>
	getDependencyFailurePolicy() === "fail_closed";

/** The 503 thrown / returned by strict-mode touchpoints. Matches the shed
 *  shape from shed503OnTransientError (errorMiddleware adds Retry-After: 1). */
export const dependencyUnavailableError = ({
	reason,
	message,
}: {
	reason: string;
	message: string;
}) =>
	new RecaseError({
		message,
		code: "service_unavailable",
		statusCode: 503,
		data: { reason },
	});

/** Response body for the direct-response sites (fail-open respond callbacks
 *  run detached after the race settled — they must not throw). */
export const dependencyUnavailableBody = ({ ctx }: { ctx: { env?: unknown } }) => ({
	message: "Service is temporarily unavailable, please retry shortly.",
	code: "service_unavailable",
	...(ctx?.env ? { env: ctx.env } : {}),
});
