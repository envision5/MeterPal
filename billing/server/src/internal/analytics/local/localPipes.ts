// billing/server/src/internal/analytics/local/localPipes.ts
//
// The Postgres-backed twin of the Tinybird pipes.
//
// Tinybird is a hosted ClickHouse: the local stack has no ClickHouse, so every
// analytics read 503s with `analytics_not_configured` and the dashboard's Usage
// page renders empty even though the `events` table holds the rows. This module
// answers the same pipe contracts straight from Postgres so the stack runs
// end to end offline.
//
// It is deliberately shaped like `getTinybirdPipes()`: same method names, same
// parameter names, same row shapes. Everything above the pipe boundary -- the
// period grid, the pivot/format helpers, the response shaping -- is shared
// verbatim, so there is exactly one implementation of the *contract* and two of
// the *storage engine*.
//
// What matches the ClickHouse semantics, and why it matters:
//   - `sum(coalesce(value, 1))` -- a NULL value counts as 1, not 0. ClickHouse
//     does this in every rollup MV; the same rule is applied here so a local
//     total equals a production total.
//   - `count(*)` is the event count, kept separate from the value sum.
//   - Periods are the same "%F %T" wall-clock strings ClickHouse emits, so
//     `convertPeriodsToEpoch` parses them identically.
//   - Hour buckets are UTC; day/week/month buckets are wall-clock in the
//     viewer's timezone.
//
// Two Postgres-specific details worth knowing:
//
//   1. `events.timestamp` is `timestamptz`, but every date bound crossing this
//      module is a UTC *wall-clock* string ("YYYY-MM-DD HH:MM:SS"). Comparing
//      those directly would let the session timezone shift the window, so
//      every bound is made explicit with `AT TIME ZONE 'UTC'`.
//
//   2. `events.properties` is `jsonb` here, where ClickHouse stores it as a
//      JSON *string*. Dotted filter keys therefore resolve through
//      `jsonb_extract_path_text`, which is the Postgres spelling of
//      ClickHouse's `properties.a.b` column access.

import { sql, type SQL } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import type {
	AggregateDeductionsPipeRow,
	AggregateGroupablePipeRow,
	AggregateSimplePipeRow,
	ListEventsPaginatedPipeRow,
} from "@/external/tinybird/initTinybird.js";

/** A "YYYY-MM-DD HH:MM:SS" wall-clock string, the format the pipes emit. */
const PERIOD_FORMAT = "YYYY-MM-DD HH24:MI:SS";
/** A "YYYY-MM-DD HH:MM:SS.ffffff" UTC timestamp, the format the pipes emit. */
const TIMESTAMP_FORMAT = "YYYY-MM-DD HH24:MI:SS.US";

/**
 * A UTC wall-clock string bound as an absolute instant.
 *
 * `timestamp` is `timestamptz`; the bound is `timestamp without time zone`, so
 * Postgres would otherwise interpret it in the session timezone. The explicit
 * `AT TIME ZONE 'UTC'` pins the meaning to UTC, matching how the pipes treat
 * their date parameters.
 */
const utcBound = (value: string): SQL => sql`(${value}::timestamp AT TIME ZONE 'UTC')`;

/** An `IN (...)` list with one bound parameter per value. */
const inList = (values: string[]): SQL =>
	sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	);

/**
 * The ClickHouse value-shape gate, applied to property values before they are
 * allowed to become a group. It drops high-entropy values (UUIDs, long hex,
 * long opaque tokens) so a requestId-class key cannot explode the grouping.
 */
const propertyValueGate = (valueExpr: SQL): SQL => sql`
	${valueExpr} <> ''
	AND length(${valueExpr}) <= 64
	AND NOT (${valueExpr} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
	AND NOT (${valueExpr} ~* '^[0-9a-f]{24,}$')
	AND NOT (${valueExpr} ~* '^[A-Za-z0-9_-]{32,}$')
`;

/** The bucket expression for a period, matching the pipes' bin semantics. */
const periodExpr = ({
	binSize,
	timezone,
}: {
	binSize: string;
	timezone: string;
}): SQL => {
	// Hour buckets stay on UTC to match the pipes' raw `hour` column.
	if (binSize === "hour") {
		return sql`to_char(date_trunc('hour', "timestamp" AT TIME ZONE 'UTC'), '${sql.raw(PERIOD_FORMAT)}')`;
	}

	// Day/week/month buckets are wall-clock in the viewer's timezone. The
	// parameter is cast so Postgres never has to infer its type.
	const tz = sql`${timezone}::text`;
	if (binSize === "month") {
		return sql`to_char(date_trunc('month', "timestamp" AT TIME ZONE ${tz}), '${sql.raw(PERIOD_FORMAT)}')`;
	}
	if (binSize === "week") {
		// Postgres weeks start on Monday, matching toStartOfWeek(hour, 1, tz).
		return sql`to_char(date_trunc('week', "timestamp" AT TIME ZONE ${tz}), '${sql.raw(PERIOD_FORMAT)}')`;
	}
	return sql`to_char(date_trunc('day', "timestamp" AT TIME ZONE ${tz}), '${sql.raw(PERIOD_FORMAT)}')`;
};

/** The `filter_by` predicates, applied to the event's JSON properties. */
const filterByExpr = ({
	filterBy,
}: {
	filterBy?: Record<string, string>;
}): SQL => {
	if (!filterBy) return sql``;
	const parts: SQL[] = [];
	for (const [key, value] of Object.entries(filterBy).slice(0, 5)) {
		// A dotted key addresses a nested path, the same way ClickHouse's
		// `properties.a.b` column access does.
		const path = key.split(".");
		parts.push(
			sql`jsonb_extract_path_text(coalesce("properties", '{}'::jsonb), ${sql.join(
				path.map((segment) => sql`${segment}`),
				sql`, `,
			)}) = ${value}`,
		);
	}
	if (parts.length === 0) return sql``;
	return sql` AND ${sql.join(parts, sql` AND `)}`;
};

/** The group expression for a grouping column, matching the pipes. */
const groupExpr = ({
	groupColumn,
}: {
	groupColumn: string;
}): SQL => {
	if (groupColumn === "customer_id") return sql`"customer_id"`;
	if (groupColumn === "entity_id") return sql`coalesce("entity_id", '')`;
	if (groupColumn === "plan_id") return sql`coalesce("internal_product_id", '')`;
	return sql`kv.property_value`;
};

/** Collect the indexed filter_key_N / filter_value_N pairs into a map. */
const collectFilters = (params: Record<string, unknown>) => {
	const filters: Record<string, string> = {};
	for (let i = 0; i < 5; i++) {
		const key = params[`filter_key_${i}`];
		const value = params[`filter_value_${i}`];
		if (typeof key === "string" && key !== "" && typeof value === "string") {
			filters[key] = value;
		}
	}
	return filters;
};

/** The columns the list pipes project, matching the pipes' row shape. */
const eventsSelect = sql`
	SELECT
		"id" AS id,
		"org_id" AS org_id,
		"env" AS env,
		"customer_id" AS customer_id,
		"event_name" AS event_name,
		to_char("timestamp" AT TIME ZONE 'UTC', '${sql.raw(TIMESTAMP_FORMAT)}') AS timestamp,
		"value"::double precision AS value,
		coalesce("properties", '{}'::jsonb)::text AS properties,
		"idempotency_key" AS idempotency_key,
		coalesce("entity_id", '') AS entity_id,
		"deductions"::text AS deductions
	FROM "events"
`;

export type LocalPipes = {
	aggregateSimple: (params: {
		org_id: string;
		env: string;
		event_names: string[];
		start_date: string;
		end_date: string;
		bin_size: string;
		timezone: string;
		customer_id?: string;
		entity_id?: string;
		filter_key_0?: string;
		filter_value_0?: string;
		filter_key_1?: string;
		filter_value_1?: string;
		filter_key_2?: string;
		filter_value_2?: string;
		filter_key_3?: string;
		filter_value_3?: string;
		filter_key_4?: string;
		filter_value_4?: string;
	}) => Promise<{ data: AggregateSimplePipeRow[] }>;
	aggregateGroupable: (params: {
		org_id: string;
		env: string;
		event_names: string[];
		start_date: string;
		end_date: string;
		bin_size: string;
		timezone: string;
		customer_id?: string;
		entity_id?: string;
		// Optional to match the pipe's zod `.default("property")` input type.
		group_column?: "property" | "customer_id" | "entity_id" | "plan_id";
		property_key?: string;
		filter_key_0?: string;
		filter_value_0?: string;
		filter_key_1?: string;
		filter_value_1?: string;
		filter_key_2?: string;
		filter_value_2?: string;
		filter_key_3?: string;
		filter_value_3?: string;
		filter_key_4?: string;
		filter_value_4?: string;
		max_groups?: number;
		/**
		 * No-op here. ClickHouse's gated property rollup can drop rows, so the
		 * server retries against the ungated source with this flag; Postgres
		 * reads the raw events and never loses a row, so there is nothing to
		 * skip. Accepted so both engines satisfy one contract.
		 */
		skip_property_rollup?: "0" | "1";
	}) => Promise<{ data: AggregateGroupablePipeRow[] }>;
	aggregateDeductions: (params: {
		org_id: string;
		env: string;
		customer_id: string;
		start_date: string;
		end_date: string;
		bin_size: string;
		timezone: string;
		feature_ids?: string[];
		entity_id?: string;
		group_column?: "entity_id" | "source_feature_id" | "plan_id";
		property_key?: string;
		max_groups?: number;
	}) => Promise<{ data: AggregateDeductionsPipeRow[] }>;
	listEventNames: (params: {
		org_id: string;
		env: string;
		customer_id?: string;
		entity_id?: string;
		limit?: number;
		start_date?: string;
		end_date?: string;
	}) => Promise<{ data: { event_name: string; event_count: number }[] }>;
	listEventsPaginated: (params: {
		org_id: string;
		env: string;
		start_date?: string;
		end_date?: string;
		customer_id?: string;
		entity_id?: string;
		event_names?: string[];
		limit?: number;
		offset?: number;
		filter_key_0?: string;
		filter_value_0?: string;
		filter_key_1?: string;
		filter_value_1?: string;
		filter_key_2?: string;
		filter_value_2?: string;
		filter_key_3?: string;
		filter_value_3?: string;
		filter_key_4?: string;
		filter_value_4?: string;
	}) => Promise<{ data: ListEventsPaginatedPipeRow[] }>;
	listEventsCursor: (params: {
		org_id: string;
		env: string;
		start_date?: string;
		end_date?: string;
		customer_id?: string;
		entity_id?: string;
		event_names?: string[];
		limit?: number;
		cursor_timestamp?: string;
		cursor_id?: string;
		filter_key_0?: string;
		filter_value_0?: string;
		filter_key_1?: string;
		filter_value_1?: string;
		filter_key_2?: string;
		filter_value_2?: string;
		filter_key_3?: string;
		filter_value_3?: string;
		filter_key_4?: string;
		filter_value_4?: string;
	}) => Promise<{ data: ListEventsPaginatedPipeRow[] }>;
};

/**
 * The Postgres-backed pipes. `db` is the billing server's own pool, so this
 * reads the same `events` table the write path fills.
 */
export const createLocalPipes = (db: DrizzleCli): LocalPipes => {
	const aggregateSimple: LocalPipes["aggregateSimple"] = async (params) => {
		const period = periodExpr({
			binSize: params.bin_size,
			timezone: params.timezone,
		});
		const filters = collectFilters(params);

		const rows = await db.execute(sql`
			SELECT
				${period} AS period,
				"event_name" AS event_name,
				sum(coalesce("value", 1)::double precision) AS total_value
			FROM "events"
			WHERE "org_id" = ${params.org_id}
				AND "env" = ${params.env}
				AND "event_name" IN (${inList(params.event_names)})
				AND "timestamp" >= ${utcBound(params.start_date)}
				AND "timestamp" <= ${utcBound(params.end_date)}
				${params.customer_id ? sql`AND "customer_id" = ${params.customer_id}` : sql``}
				${params.entity_id ? sql`AND "entity_id" = ${params.entity_id}` : sql``}
				${filterByExpr({ filterBy: filters })}
			GROUP BY period, "event_name"
			ORDER BY period, "event_name"
		`);

		return {
			data: rows.map((row: any) => ({
				period: String(row.period),
				event_name: String(row.event_name),
				total_value: Number(row.total_value ?? 0),
			})),
		};
	};

	const aggregateGroupable: LocalPipes["aggregateGroupable"] = async (params) => {
		const period = periodExpr({
			binSize: params.bin_size,
			timezone: params.timezone,
		});
		const filters = collectFilters(params);
		const groupColumn = params.group_column ?? "property";
		const propertyKey = params.property_key;
		const maxGroups = params.max_groups ?? 9;
		const isProperty = groupColumn === "property";

		// A property grouping reads the event's JSON as key/value pairs; every
		// other grouping reads a column. Both shapes collapse to one
		// (period, event_name, gvalue, total_value, event_count) row set.
		const source = sql`
			SELECT
				${period} AS period,
				"event_name" AS event_name,
				${groupExpr({ groupColumn })} AS gvalue,
				sum(coalesce("value", 1)::double precision) AS total_value,
				count(*)::double precision AS event_count
			FROM "events"
			${isProperty
				? sql`CROSS JOIN LATERAL jsonb_each_text(coalesce("properties", '{}'::jsonb)) AS kv(property_key, property_value)`
				: sql``}
			WHERE "org_id" = ${params.org_id}
				AND "env" = ${params.env}
				AND "event_name" IN (${inList(params.event_names)})
				AND "timestamp" >= ${utcBound(params.start_date)}
				AND "timestamp" <= ${utcBound(params.end_date)}
				${params.customer_id ? sql`AND "customer_id" = ${params.customer_id}` : sql``}
				${params.entity_id ? sql`AND "entity_id" = ${params.entity_id}` : sql``}
				${isProperty
					? sql`AND kv.property_key = ${propertyKey ?? ""} AND ${propertyValueGate(sql`kv.property_value`)}`
					: sql``}
				${filterByExpr({ filterBy: filters })}
			GROUP BY period, "event_name", gvalue
		`;

		// Per-bin top N, with the overflow folded into AUTUMN_RESERVED -- the
		// same contract the ClickHouse pipe returns, so the shared formatter
		// renders it identically.
		const rows = await db.execute(sql`
			WITH grouped AS (${source}),
			ranked AS (
				SELECT
					period,
					event_name,
					gvalue,
					total_value,
					event_count,
					row_number() OVER (
						PARTITION BY period, event_name
						ORDER BY total_value DESC, gvalue ASC
					) AS rn
				FROM grouped
			)
			SELECT
				period,
				event_name,
				CASE WHEN rn <= ${maxGroups} THEN gvalue ELSE 'AUTUMN_RESERVED' END AS group_value,
				sum(total_value) AS total_value,
				sum(event_count) AS event_count,
				bool_or(rn > ${maxGroups}) AS _truncated
			FROM ranked
			GROUP BY period, event_name, group_value
			ORDER BY period, event_name, group_value
		`);

		return {
			data: rows.map((row: any) => ({
				period: String(row.period),
				event_name: String(row.event_name),
				group_value: String(row.group_value),
				total_value: Number(row.total_value ?? 0),
				event_count: Number(row.event_count ?? 0),
				_truncated: Boolean(row._truncated),
			})),
		};
	};

	const aggregateDeductions: LocalPipes["aggregateDeductions"] = async (params) => {
		const period = periodExpr({
			binSize: params.bin_size,
			timezone: params.timezone,
		});
		const maxGroups = params.max_groups ?? 9;
		const groupColumn = params.group_column;
		const propertyKey = params.property_key;

		// `deductions` is a jsonb array of deduction objects. ClickHouse stores
		// the same data double-encoded and fans it out with ARRAY JOIN; here the
		// fan-out is a lateral jsonb_array_elements.
		const groupValue = (() => {
			if (propertyKey) {
				const path = propertyKey.split(".");
				return sql`jsonb_extract_path_text(coalesce("properties", '{}'::jsonb), ${sql.join(
					path.map((segment) => sql`${segment}`),
					sql`, `,
				)})`;
			}
			if (groupColumn === "entity_id") return sql`coalesce("entity_id", '')`;
			if (groupColumn === "source_feature_id") return sql`"event_name"`;
			if (groupColumn === "plan_id") return sql`coalesce(d->>'plan_id', '')`;
			return sql`''`;
		})();

		// feature_ids matches EITHER side of the edge, exactly like the pipe.
		const featureFilter = params.feature_ids?.length
			? sql`
				AND (
					"event_name" IN (${inList(params.feature_ids)})
					OR d->>'feature_id' IN (${inList(params.feature_ids)})
				)`
			: sql``;

		// The pipe ranks groups over the WHOLE window per balance, so the same
		// groups are kept in every bin. Ranking per bin would make segments
		// appear and vanish between columns.
		const base = sql`
			SELECT
				${period} AS period,
				d->>'feature_id' AS balance_feature_id,
				d->>'balance_id' AS balance_id,
				coalesce(d->>'plan_id', '') AS plan_id,
				coalesce(d->'reset'->>'interval', '') AS reset_interval,
				${groupValue} AS gvalue,
				sum((d->>'value')::double precision) AS deducted,
				count(*)::double precision AS deduction_count
			FROM "events"
			CROSS JOIN LATERAL jsonb_array_elements(coalesce("deductions", '[]'::jsonb)) AS d
			WHERE "org_id" = ${params.org_id}
				AND "env" = ${params.env}
				AND "customer_id" = ${params.customer_id}
				AND "timestamp" >= ${utcBound(params.start_date)}
				AND "timestamp" <= ${utcBound(params.end_date)}
				AND coalesce(d->>'balance_id', '') <> ''
				${featureFilter}
				${params.entity_id ? sql`AND "entity_id" = ${params.entity_id}` : sql``}
				${groupColumn === "entity_id" ? sql`AND coalesce("entity_id", '') <> ''` : sql``}
			GROUP BY period, balance_feature_id, balance_id, plan_id, reset_interval, gvalue
		`;

		const rows = await db.execute(sql`
			WITH base AS (${base}),
			window_ranked AS (
				SELECT
					balance_id,
					gvalue,
					row_number() OVER (
						PARTITION BY balance_id
						ORDER BY sum(deducted) DESC, gvalue ASC
					) AS rn
				FROM base
				GROUP BY balance_id, gvalue
			)
			SELECT
				base.period AS period,
				base.balance_feature_id AS balance_feature_id,
				base.balance_id AS balance_id,
				base.plan_id AS plan_id,
				base.reset_interval AS reset_interval,
				CASE
					WHEN window_ranked.rn <= ${maxGroups} THEN base.gvalue
					ELSE 'AUTUMN_RESERVED'
				END AS group_value,
				sum(base.deducted) AS deducted,
				sum(base.deduction_count) AS deduction_count,
				bool_or(window_ranked.rn > ${maxGroups}) AS _truncated
			FROM base
			INNER JOIN window_ranked
				ON base.balance_id = window_ranked.balance_id
				AND base.gvalue = window_ranked.gvalue
			GROUP BY period, balance_feature_id, balance_id, plan_id, reset_interval, group_value
			ORDER BY period, balance_feature_id, balance_id, group_value
		`);

		return {
			data: rows.map((row: any) => ({
				period: String(row.period),
				balance_feature_id: String(row.balance_feature_id ?? ""),
				balance_id: String(row.balance_id ?? ""),
				plan_id: String(row.plan_id ?? ""),
				reset_interval: String(row.reset_interval ?? ""),
				group_value: String(row.group_value ?? ""),
				deducted: Number(row.deducted ?? 0),
				deduction_count: Number(row.deduction_count ?? 0),
				_truncated: Boolean(row._truncated),
			})),
		};
	};

	const listEventNames: LocalPipes["listEventNames"] = async (params) => {
		const rows = await db.execute(sql`
			SELECT
				"event_name" AS event_name,
				count(*)::double precision AS event_count
			FROM "events"
			WHERE "org_id" = ${params.org_id}
				AND "env" = ${params.env}
				${params.customer_id ? sql`AND "customer_id" = ${params.customer_id}` : sql``}
				${params.entity_id ? sql`AND "entity_id" = ${params.entity_id}` : sql``}
				${params.start_date ? sql`AND "timestamp" >= ${utcBound(params.start_date)}` : sql``}
				${params.end_date ? sql`AND "timestamp" <= ${utcBound(params.end_date)}` : sql``}
			GROUP BY "event_name"
			HAVING count(*) > 0
			ORDER BY event_count DESC
			${params.limit ? sql`LIMIT ${params.limit}` : sql``}
		`);

		return {
			data: rows.map((row: any) => ({
				event_name: String(row.event_name),
				event_count: Number(row.event_count ?? 0),
			})),
		};
	};

	const listEventsPaginated: LocalPipes["listEventsPaginated"] = async (params) => {
		const filters = collectFilters(params);

		const rows = await db.execute(sql`
			${eventsSelect}
			WHERE "org_id" = ${params.org_id}
				AND "env" = ${params.env}
				${params.start_date ? sql`AND "timestamp" >= ${utcBound(params.start_date)}` : sql``}
				${params.end_date ? sql`AND "timestamp" <= ${utcBound(params.end_date)}` : sql``}
				${params.customer_id ? sql`AND "customer_id" = ${params.customer_id}` : sql``}
				${params.entity_id ? sql`AND "entity_id" = ${params.entity_id}` : sql``}
				${params.event_names?.length ? sql`AND "event_name" IN (${inList(params.event_names)})` : sql``}
				${filterByExpr({ filterBy: filters })}
			ORDER BY "timestamp" DESC, "id" DESC
			${params.limit ? sql`LIMIT ${params.limit}` : sql``}
			${params.offset ? sql`OFFSET ${params.offset}` : sql``}
		`);

		return { data: rows.map(toPipeEventRow) };
	};

	const listEventsCursor: LocalPipes["listEventsCursor"] = async (params) => {
		const filters = collectFilters(params);

		// The cursor is (timestamp, id) descending -- the same keyset the
		// ClickHouse pipe pages on.
		const cursorPredicate =
			params.cursor_id && params.cursor_timestamp
				? sql`AND ("timestamp", "id") < (${utcBound(params.cursor_timestamp)}, ${params.cursor_id})`
				: sql``;

		const rows = await db.execute(sql`
			${eventsSelect}
			WHERE "org_id" = ${params.org_id}
				AND "env" = ${params.env}
				${params.start_date ? sql`AND "timestamp" >= ${utcBound(params.start_date)}` : sql``}
				${params.end_date ? sql`AND "timestamp" <= ${utcBound(params.end_date)}` : sql``}
				${params.customer_id ? sql`AND "customer_id" = ${params.customer_id}` : sql``}
				${params.entity_id ? sql`AND "entity_id" = ${params.entity_id}` : sql``}
				${params.event_names?.length ? sql`AND "event_name" IN (${inList(params.event_names)})` : sql``}
				${filterByExpr({ filterBy: filters })}
				${cursorPredicate}
			ORDER BY "timestamp" DESC, "id" DESC
			${params.limit ? sql`LIMIT ${params.limit}` : sql``}
		`);

		return { data: rows.map(toPipeEventRow) };
	};

	return {
		aggregateSimple,
		aggregateGroupable,
		aggregateDeductions,
		listEventNames,
		listEventsPaginated,
		listEventsCursor,
	};
};

/** Normalize a Postgres row into the pipe's event row shape. */
const toPipeEventRow = (row: any): ListEventsPaginatedPipeRow => ({
	id: String(row.id),
	org_id: String(row.org_id),
	env: String(row.env),
	customer_id: String(row.customer_id),
	event_name: String(row.event_name),
	timestamp: String(row.timestamp),
	value: row.value == null ? null : Number(row.value),
	properties: row.properties == null ? null : String(row.properties),
	idempotency_key:
		row.idempotency_key == null ? null : String(row.idempotency_key),
	entity_id: row.entity_id == null ? null : String(row.entity_id),
	deductions: row.deductions == null ? null : String(row.deductions),
});

/**
 * The local twin of `getCountAndSum`'s ClickHouse query: one row per event
 * name with the event count and the value sum.
 */
export const localGetCountAndSum = async ({
	db,
	orgId,
	env,
	eventNames,
	startDate,
	endDate,
	customerId,
	entityId,
	filterBy,
}: {
	db: DrizzleCli;
	orgId: string;
	env: string;
	eventNames: string[];
	startDate: string;
	endDate: string;
	customerId?: string;
	entityId?: string;
	filterBy?: Record<string, string>;
}): Promise<Record<string, { count: number; sum: number }>> => {
	const filters = collectFilters({
		...Object.fromEntries(
			Object.entries(filterBy ?? {}).map(([key, value], index) => [
				`filter_key_${index}`,
				key,
			]),
		),
		...Object.fromEntries(
			Object.entries(filterBy ?? {}).map(([key, value], index) => [
				`filter_value_${index}`,
				value,
			]),
		),
	});

	const rows = await db.execute(sql`
		SELECT
			"event_name" AS event_name,
			count(*)::double precision AS count,
			sum(coalesce("value", 1)::double precision) AS sum
		FROM "events"
		WHERE "org_id" = ${orgId}
			AND "env" = ${env}
			AND "event_name" IN (${inList(eventNames)})
			AND "timestamp" >= ${utcBound(startDate)}
			AND "timestamp" <= ${utcBound(endDate)}
			${customerId ? sql`AND "customer_id" = ${customerId}` : sql``}
			${entityId ? sql`AND "entity_id" = ${entityId}` : sql``}
			${filterByExpr({ filterBy: filters })}
		GROUP BY "event_name"
	`);

	const summary: Record<string, { count: number; sum: number }> = {};
	for (const row of rows as any[]) {
		summary[String(row.event_name)] = {
			count: Number(row.count ?? 0),
			sum: Number(row.sum ?? 0),
		};
	}
	return summary;
};

/** The local twin of `getTopEventNames`: the busiest event names in the last month. */
export const localGetTopEventNames = async ({
	db,
	orgId,
	env,
	limit,
}: {
	db: DrizzleCli;
	orgId: string;
	env: string;
	limit: number;
}): Promise<{ event_name: string; count: string }[]> => {
	const rows = await db.execute(sql`
		SELECT
			"event_name" AS event_name,
			count(*)::bigint AS count
		FROM "events"
		WHERE "org_id" = ${orgId}
			AND "env" = ${env}
			AND "timestamp" >= now() - INTERVAL '1 month'
		GROUP BY "event_name"
		ORDER BY count(*) DESC
		LIMIT ${limit}
	`);

	return rows.map((row: any) => ({
		event_name: String(row.event_name),
		count: String(row.count),
	}));
};

/** The local twin of `getEventById`. Throws if the event is not found. */
export const localGetEventById = async ({
	db,
	orgId,
	env,
	eventId,
}: {
	db: DrizzleCli;
	orgId: string;
	env: string;
	eventId: string;
}): Promise<{
	id: string;
	org_id: string;
	env: string;
	customer_id: string;
	event_name: string;
	timestamp: string;
	value: string | null;
	properties: string | null;
	idempotency_key: string | null;
	entity_id: string | null;
}> => {
	const rows = await db.execute(sql`
		SELECT
			"id" AS id,
			"org_id" AS org_id,
			"env" AS env,
			"customer_id" AS customer_id,
			"event_name" AS event_name,
			to_char("timestamp" AT TIME ZONE 'UTC', '${sql.raw(TIMESTAMP_FORMAT)}') AS timestamp,
			"value"::text AS value,
			coalesce("properties", '{}'::jsonb)::text AS properties,
			"idempotency_key" AS idempotency_key,
			coalesce("entity_id", '') AS entity_id
		FROM "events"
		WHERE "org_id" = ${orgId}
			AND "env" = ${env}
			AND "id" = ${eventId}
		LIMIT 1
	`);

	if (rows.length === 0) {
		throw new Error(`Event not found: ${eventId}`);
	}

	const row = rows[0] as any;
	return {
		id: String(row.id),
		org_id: String(row.org_id),
		env: String(row.env),
		customer_id: String(row.customer_id),
		event_name: String(row.event_name),
		timestamp: String(row.timestamp),
		value: row.value == null ? null : String(row.value),
		properties: row.properties == null ? null : String(row.properties),
		idempotency_key:
			row.idempotency_key == null ? null : String(row.idempotency_key),
		entity_id: row.entity_id == null ? null : String(row.entity_id),
	};
};
