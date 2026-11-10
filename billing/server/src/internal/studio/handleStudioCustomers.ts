// billing/server/src/internal/studio/handleStudioCustomers.ts
//
// POST /studio/customers
//
// The customer list the studio page's picker is built from.
//
// The obvious source -- the dashboard's own customer search -- answers "every
// customer in this org/env", which is the wrong question for a usage studio.
// A studio with no usage to show is an empty studio. The right question is
// "who has actually spent credits", and the answer lives in the `events`
// table.
//
// So this route reads the event log directly: the distinct customers that
// have usage, with their event counts and credit totals, and their display
// names joined in from `customers` when there is one. A customer with usage
// but no customer record still appears (named after its id), because usage
// without a customer is still usage.
//
// This is the same table the whole analytics read path reads, so the picker
// cannot offer a customer the studio then has nothing to show for.

import { Scopes } from "@autumn/shared";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";

const StudioCustomersSchema = z.object({
	/** How many customers to return. Defaults to 50. */
	limit: z.number().int().min(1).max(200).optional(),
	/** A customer id to search for by prefix. */
	search: z.string().optional(),
});

export const handleStudioCustomers = createRoute({
	scopes: [Scopes.Analytics.Read],
	body: StudioCustomersSchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { org, env } = ctx;
		const { limit, search } = c.req.valid("json");

		const rows = await ctx.db.execute(sql`
			select
				e.customer_id as id,
				coalesce(c.name, e.customer_id) as name,
				c.email as email,
				count(*)::int as events,
				sum(coalesce(e.value, 1))::double precision as credits,
				min(e.timestamp) as first_event,
				max(e.timestamp) as last_event
			from events e
			left join customers c
				on c.org_id = e.org_id
				and c.env = e.env
				and c.id = e.customer_id
			where e.org_id = ${org.id}
				and e.env = ${env}
				${search ? sql`and e.customer_id ilike ${`${search}%`}` : sql``}
			group by e.customer_id, c.name, c.email
			order by credits desc, events desc
			limit ${limit ?? 50}
		`);

		return c.json({
			customers: rows.map((row) => ({
				id: row.id as string,
				name: (row.name as string | null) ?? null,
				email: (row.email as string | null) ?? null,
				events: row.events as number,
				credits: row.credits as number,
				first_event: row.first_event
					? new Date(row.first_event as string).getTime()
					: null,
				last_event: row.last_event
					? new Date(row.last_event as string).getTime()
					: null,
			})),
		});
	},
});
