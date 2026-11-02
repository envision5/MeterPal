// GET /v1/catalog
//
// The gateway's view of what this org serves.
//
// The gateway polls this (Redis-cached, short TTL) to learn which models an
// org may call and what they cost.  It is the org-scoped catalogue, so a
// merchant never sees another merchant's models, and a merchant's price is
// the merchant's own.

import { Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import {
	getServedModelAllowList,
	getServedModelCatalog,
} from "@/internal/models/servedModelService.js";

export const handleGetCatalog = createRoute({
	scopes: [Scopes.Balances.Read],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { org, env } = ctx;

		const [models, allowList] = await Promise.all([
			getServedModelCatalog({ db: ctx.db, orgId: org.id, env }),
			getServedModelAllowList({ db: ctx.db, orgId: org.id, env }),
		]);

		return c.json({
			org_id: org.id,
			env,
			models,
			// null means "no restriction": an org that never listed a model
			// serves everything the gateway offers.
			allowed_model_ids: allowList,
		});
	},
});
