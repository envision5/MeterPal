// GET /v1/served_models
//
// The org's price sheet.

import { Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { listServedModels } from "../servedModelService.js";

export const handleListServedModels = createRoute({
	scopes: [Scopes.Organisation.Read],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const models = await listServedModels({
			db: ctx.db,
			orgId: ctx.org.id,
			env: ctx.env,
		});

		return c.json({
			models: models.map((m) => ({
				model_id: m.model_id,
				display_name: m.display_name,
				upstream_model: m.upstream_model,
				enabled: m.enabled,
				input_cost_usd_1m: m.input_cost_usd_1m,
				output_cost_usd_1m: m.output_cost_usd_1m,
				markup_pct: m.markup_pct,
				updated_at: m.updated_at,
			})),
		});
	},
});
