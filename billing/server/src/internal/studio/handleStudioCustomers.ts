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
//
// The console wallet is excluded. Its studio turns are real usage, so it
// would otherwise surface as the busiest "customer" in the org -- the
// merchant's own metering showing up as one of their users. It is not an end
// user, so it is not in the picker; its balance is returned separately, which
// is what the header reads to show what the assistant has left.

import { Scopes } from "@autumn/shared";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { litellmFeatureId } from "@/internal/keys/litellmEnv.js";
import { readWallet } from "@/internal/balances/walletProjection.js";
import { findStudioWallet, STUDIO_WALLET_ID } from "./studioWallet.js";

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
				and e.customer_id <> ${STUDIO_WALLET_ID}
				${search ? sql`and e.customer_id ilike ${`${search}%`}` : sql``}
			group by e.customer_id, c.name, c.email
			order by credits desc, events desc
			limit ${limit ?? 50}
		`);

		// The console wallet's own balance, read-only: opening the page must
		// not create a wallet in an org that never uses the assistant.
		const wallet = await findStudioWallet({ ctx });
		// This number is rendered in the studio header, so it uses the same
		// settled projection as every other customer-facing credit display.
		// The raw entitlement balance dips by the worst-case reservation for
		// the whole duration of an assistant turn, which would make the
		// header flicker down and back on every question.
		const walletBalance = wallet
			? (
					await readWallet({
						db: ctx.db,
						orgId: org.id,
						env,
						customerId: STUDIO_WALLET_ID,
						featureId: litellmFeatureId(),
					})
				).settled
			: null;

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
			wallet: {
				id: STUDIO_WALLET_ID,
				provisioned: Boolean(wallet),
				balance: walletBalance,
			},
		});
	},
});
