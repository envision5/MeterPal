// GET /v1/served_models
//
// The org's price sheet, with each model's gateway deployments.  Deployments
// are the instances behind a model -- one provider account and key each --
// and the gateway load-balances across them.  Only the key's last four
// characters come back: the stored key never leaves the server.

import { Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { listDeployments, toDeploymentResponse } from "../deploymentService.js";
import { listServedModels } from "../servedModelService.js";

export const handleListServedModels = createRoute({
	scopes: [Scopes.Organisation.Read],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const [models, deployments] = await Promise.all([
			listServedModels({
				db: ctx.db,
				orgId: ctx.org.id,
				env: ctx.env,
			}),
			listDeployments({ ctx, orgId: ctx.org.id, env: ctx.env }),
		]);

		const byModel = new Map<string, typeof deployments>();
		for (const deployment of deployments) {
			const list = byModel.get(deployment.model_id) ?? [];
			list.push(deployment);
			byModel.set(deployment.model_id, list);
		}

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
				deployments: (byModel.get(m.model_id) ?? []).map((d) =>
					toDeploymentResponse(d),
				),
			})),
		});
	},
});
