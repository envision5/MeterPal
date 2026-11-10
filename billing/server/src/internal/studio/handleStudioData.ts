// billing/server/src/internal/studio/handleStudioData.ts
//
// POST /studio/data
//
// The AG Studio data source.
//
// AG Studio ships no database connectors: the app supplies the data. This
// route is the app supplying it -- the same `events` table the rest of the
// dashboard reads, shaped as a fact table the studio's engine can group,
// filter and chart.
//
// Two tables:
//
//   usage_daily  one row per (day, event, customer) with the credits spent
//                and the event count -- the table the agent builds charts from
//   events       the raw event log, for drilling into a single row
//
// No server-side pagination, filtering or sorting is declared. AG Studio's
// built-in engine handles that in the browser, and the local dataset is far
// below the engine's limit, so the simplest correct contract is the one with
// the fewest ways to be subtly wrong.

import { Scopes } from "@autumn/shared";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { getAnalyticsPipes } from "@/internal/analytics/local/analyticsPipes.js";
import { epochToDateTime } from "@autumn/shared/api/common/epochUtils";

const StudioDataSchema = z.object({
	/** Which table to read. Defaults to `usage_daily`. */
	table: z.enum(["usage_daily", "events"]).default("usage_daily"),
	/** Scope to one customer. Omit for the whole org. */
	customer_id: z.string().optional(),
	/** Scope to these event names. Omit for every event name. */
	event_names: z.array(z.string()).optional(),
	/** "YYYY-MM-DD HH:MM:SS" in UTC. */
	start_date: z.string().optional(),
	/** "YYYY-MM-DD HH:MM:SS" in UTC. */
	end_date: z.string().optional(),
	limit: z.number().int().min(1).max(5000).optional(),
});

/** The default window: the last 30 days. */
const defaultWindow = () => {
	const end = new Date();
	const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
	return {
		startDate: epochToDateTime(start.getTime()),
		endDate: epochToDateTime(end.getTime()),
	};
};

export const handleStudioData = createRoute({
	scopes: [Scopes.Analytics.Read],
	body: StudioDataSchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { org, env } = ctx;
		const {
			table,
			customer_id,
			event_names,
			start_date,
			end_date,
			limit,
		} = c.req.valid("json");

		const pipes = getAnalyticsPipes(ctx);
		const window = {
			startDate: start_date ?? defaultWindow().startDate,
			endDate: end_date ?? defaultWindow().endDate,
		};

		if (table === "events") {
			const result = await pipes.listEventsPaginated({
				org_id: org.id,
				env,
				start_date: window.startDate,
				end_date: window.endDate,
				customer_id,
				event_names,
				limit: limit ?? 500,
			});

			return c.json({
				data: result.data.map((row) => ({
					id: row.id,
					customer_id: row.customer_id,
					event_name: row.event_name,
					timestamp: row.timestamp,
					value: row.value ?? 0,
					properties: row.properties,
				})),
			});
		}

		// `usage_daily`: one row per (day, event, customer).
		//
		// The event names come from the same list the dashboard's own usage
		// page uses, so the studio and the classic page cannot disagree about
		// what activity exists.
		const names =
			event_names && event_names.length > 0
				? event_names
				: (
						await pipes.listEventNames({
							org_id: org.id,
							env,
							customer_id,
							limit: 50,
						})
					).data.map((row) => row.event_name);

		if (names.length === 0) {
			return c.json({ data: [] });
		}

		const result = await pipes.aggregateGroupable({
			org_id: org.id,
			env,
			event_names: names,
			start_date: window.startDate,
			end_date: window.endDate,
			bin_size: "day",
			timezone: "UTC",
			customer_id,
			group_column: "customer_id",
			max_groups: 250,
		});

		return c.json({
			data: result.data.map((row) => ({
				// The pipes emit "YYYY-MM-DD HH:MM:SS"; a day bucket reads
				// better as a plain date.
				period: String(row.period).slice(0, 10),
				event_name: row.event_name,
				customer_id: row.group_value,
				credits: row.total_value,
				events: row.event_count ?? 0,
			})),
		});
	},
});
