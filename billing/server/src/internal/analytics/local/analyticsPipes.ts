// billing/server/src/internal/analytics/local/analyticsPipes.ts
//
// One analytics read path, two storage engines.
//
// Tinybird (hosted ClickHouse) is the production analytics backend and the
// source of truth for the pipe contracts in `external/tinybird/pipes`. When it
// is not configured -- the local stack, a self-hosted deployment -- the same
// contracts are served straight from Postgres by `createLocalPipes`.
//
// The gate is deliberately narrow: `isTinybirdConfigured()`. When Tinybird is
// configured, nothing here is used and production behaviour is byte-identical.
// When it is not, the alternative is a 503 on every analytics read, which is
// exactly the failure this exists to remove.

import type {
	AggregateDeductionsPipeRow,
	AggregateGroupablePipeRow,
	AggregateSimplePipeRow,
	ListEventsPaginatedPipeRow,
} from "@/external/tinybird/initTinybird.js";
import { getTinybirdPipes } from "@/external/tinybird/initTinybird.js";
import { isTinybirdConfigured } from "@/external/tinybird/tinybirdUtils.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { createLocalPipes, type LocalPipes } from "./localPipes.js";

type TinybirdPipes = ReturnType<typeof getTinybirdPipes>;

export type AnalyticsBackend = "tinybird" | "postgres";

/** The read methods both engines implement. */
type CommonPipeMethods = {
	aggregateSimple: LocalPipes["aggregateSimple"];
	aggregateGroupable: LocalPipes["aggregateGroupable"];
	aggregateDeductions: LocalPipes["aggregateDeductions"];
	listEventNames: LocalPipes["listEventNames"];
	listEventsPaginated: LocalPipes["listEventsPaginated"];
	listEventsCursor: LocalPipes["listEventsCursor"];
};

/**
 * The analytics read surface, independent of the storage engine.
 *
 * Parameter shapes mirror the pipes' zod *input* types, so the Tinybird
 * callers are assignable to this without a cast, and the Postgres
 * implementation satisfies the same contract.
 *
 * The union is discriminated on `backend` so the ClickHouse-only completeness
 * checks narrow away on the Postgres path instead of silently running against
 * an engine that has no rollups.
 */
export type AnalyticsPipes =
	| (CommonPipeMethods & {
			backend: "tinybird";
			/** ClickHouse-only: compares the gated property rollup against the
			 *  raw event totals. Postgres has no rollup, so it has no gap. */
			propertyRollupCoverage: TinybirdPipes["propertyRollupCoverage"];
	  })
	| (CommonPipeMethods & { backend: "postgres" });

export type {
	AggregateDeductionsPipeRow,
	AggregateGroupablePipeRow,
	AggregateSimplePipeRow,
	ListEventsPaginatedPipeRow,
};

/**
 * The local pipes are built per request because they close over the request's
 * database handle. The SQL is static, so this costs an object allocation, not
 * a query plan.
 */
const localPipesFor = (ctx: AutumnContext): LocalPipes =>
	createLocalPipes(ctx.db);

/**
 * Resolves the analytics pipes for a request.
 *
 * Tinybird wins whenever it is configured -- that is the production path and
 * it stays untouched. Otherwise the Postgres twin answers the same contracts.
 */
export const getAnalyticsPipes = (ctx: AutumnContext): AnalyticsPipes => {
	if (isTinybirdConfigured()) {
		const pipes = getTinybirdPipes();
		return {
			backend: "tinybird",
			aggregateSimple: pipes.aggregateSimple,
			aggregateGroupable: pipes.aggregateGroupable,
			aggregateDeductions: pipes.aggregateDeductions,
			listEventNames: pipes.listEventNames,
			listEventsPaginated: pipes.listEventsPaginated,
			listEventsCursor: pipes.listEventsCursor,
			propertyRollupCoverage: pipes.propertyRollupCoverage,
		};
	}

	const pipes = localPipesFor(ctx);
	return {
		backend: "postgres",
		aggregateSimple: pipes.aggregateSimple,
		aggregateGroupable: pipes.aggregateGroupable,
		aggregateDeductions: pipes.aggregateDeductions,
		listEventNames: pipes.listEventNames,
		listEventsPaginated: pipes.listEventsPaginated,
		listEventsCursor: pipes.listEventsCursor,
	};
};
