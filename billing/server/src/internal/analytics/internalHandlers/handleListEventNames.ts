import { Scopes } from "@autumn/shared";
import { z } from "zod/v4";
import { isTinybirdConfigured } from "@/external/tinybird/tinybirdUtils.js";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { eventActions } from "../actions/eventActions.js";

const ListEventNamesSchema = z.object({
	customer_id: z.string().optional(),
	entity_id: z.string().optional(),
	limit: z.coerce.number().optional(),
	interval: z.string().optional(),
	bin_size: z.enum(["day", "hour", "week", "month"]).optional(),
	start: z.coerce.number().optional(),
	end: z.coerce.number().optional(),
});

/**
 * List distinct event names for the org (or one customer) sorted by popularity
 */
export const handleListEventNames = createRoute({
	scopes: [Scopes.Analytics.Read],
	query: ListEventNamesSchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { customer_id, entity_id, limit, interval, bin_size, start, end } =
			c.req.valid("query");

		// No Tinybird means no analytics pipeline, so there are no event names to
		// list. The dashboard queries this on every page load, and a 503 here is
		// pure noise in a stack that doesn't run the cloud analytics backend.
		if (!isTinybirdConfigured()) {
			return c.json({ eventNames: [] });
		}

		const customRange =
			interval === "custom" && start !== undefined && end !== undefined
				? { start, end }
				: undefined;

		const eventNames = await eventActions.listEventNames({
			ctx,
			customerId: customer_id,
			entityId: entity_id,
			limit,
			interval,
			binSize: bin_size,
			customRange,
		});

		return c.json({
			eventNames,
		});
	},
});
