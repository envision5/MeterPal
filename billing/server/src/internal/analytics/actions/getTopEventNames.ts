import {
	buildTopEventNamesCacheKey,
	getCachedTopEventNames,
	setCachedTopEventNames,
} from "@/external/redis/actions/topEventNamesCache/topEventNamesCache.js";
import { getClickhouseClient } from "@/external/tinybird/initClickhouse.js";
import { isTinybirdConfigured } from "@/external/tinybird/tinybirdUtils.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { localGetTopEventNames } from "@/internal/analytics/local/localPipes.js";

type TopEventNameRow = {
	event_name: string;
	count: string;
};

type TopEventNamesResult = {
	eventNames: string[];
	result: { data: TopEventNameRow[] };
};

/** Gets top event names by count for the organization */
export const getTopEventNames = async ({
	ctx,
	limit = 3,
}: {
	ctx: AutumnContext;
	limit?: number;
}): Promise<TopEventNamesResult> => {
	const { org, env } = ctx;
	const cacheKey = buildTopEventNamesCacheKey({ orgId: org.id, env, limit });

	const cached = await getCachedTopEventNames<TopEventNamesResult>({
		ctx,
		cacheKey,
	});
	if (cached) return cached;

	ctx.logger.debug("Querying top event names", {
		orgId: org.id,
		env,
		limit,
	});

	const startTime = performance.now();

	// Without ClickHouse the ranking comes from the Postgres events table.
	if (!isTinybirdConfigured()) {
		const rows = await localGetTopEventNames({
			db: ctx.db,
			orgId: org.id,
			env,
			limit,
		});
		const eventNames = rows.map((row) => row.event_name);
		const queryDuration = performance.now() - startTime;

		ctx.logger.debug("Top event names result (postgres)", {
			queryMs: Math.round(queryDuration),
			count: eventNames.length,
			eventNames,
		});

		const value: TopEventNamesResult = {
			eventNames,
			result: { data: rows },
		};
		await setCachedTopEventNames({ ctx, cacheKey, value });

		return value;
	}

	const ch = getClickhouseClient();

	const query = `
		SELECT count(*) as count, event_name
		FROM events
		WHERE org_id = {org_id:String}
			AND env = {env:String}
			AND timestamp >= NOW() - INTERVAL 1 MONTH
		GROUP BY event_name
		ORDER BY count(*) DESC
		LIMIT {limit:UInt32}
	`;

	const result = await ch.query({
		query,
		query_params: {
			org_id: org.id,
			env,
			limit,
		},
		format: "JSON",
	});

	const resultJson = (await result.json()) as { data: TopEventNameRow[] };
	const eventNames = resultJson.data.map((row) => row.event_name);
	const queryDuration = performance.now() - startTime;

	ctx.logger.debug("Top event names result", {
		queryMs: Math.round(queryDuration),
		count: eventNames.length,
		eventNames,
	});

	const value: TopEventNamesResult = {
		eventNames,
		result: resultJson,
	};
	await setCachedTopEventNames({ ctx, cacheKey, value });

	return value;
};
