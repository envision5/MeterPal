// GET /v1/served_models
//
// The org's price sheet, with each model's gateway deployments.  Deployments
// are the instances behind a model -- one provider account and key each --
// and the gateway load-balances across them.  Only the key's last four
// characters come back: the stored key never leaves the server.
//
// Each row also carries the markup that will actually be charged, and where
// it came from.  The dashboard shows that number next to the merchant's own
// price, so the "effective price" on screen is the price on the invoice --
// a dashboard that resolves markup its own way drifts from the runtime.

import { isAiCreditSystem } from "@autumn/shared";
import { Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { getModelsDevPricing } from "@/internal/features/utils/getModelPricing.js";
import type { ModelPricingData } from "@/external/redis/actions/modelPricingCache/modelPricingCache.js";
import { listDeployments, toDeploymentResponse } from "../deploymentService.js";
import { resolveEffectiveMarkup } from "../resolveModelRates.js";
import { listServedModels, pricingFromRow } from "../servedModelService.js";

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

		// The provider feed is read once for the whole sheet: reading it
		// parses a large payload, and a sheet of twenty models would pay for
		// that twenty times over.  An empty feed means "no model resolves",
		// which is what an unreachable feed means to the request path too.
		const pricingData = await getModelsDevPricing().catch(
			() => ({}) as ModelPricingData,
		);

		// The AI credit feature carries the markup.  With one AI credit
		// system per org -- the norm -- this is the same feature the check
		// path resolves.
		const creditSystem = ctx.features.find((f) => isAiCreditSystem(f.type));

		const markups = await Promise.all(
			models.map(async (m) => {
				const { markup, source, planMarkup } = await resolveEffectiveMarkup({
					modelId: m.model_id,
					creditSystem: creditSystem ?? null,
					served: pricingFromRow(m),
					pricingData,
				});
				return [m.model_id, { markup, source, planMarkup }] as const;
			}),
		);
		const markupByModel = new Map(markups);

		return c.json({
			models: models.map((m) => {
				const resolved = markupByModel.get(m.model_id);
				return {
					model_id: m.model_id,
					display_name: m.display_name,
					upstream_model: m.upstream_model,
					enabled: m.enabled,
					input_cost_usd_1m: m.input_cost_usd_1m,
					output_cost_usd_1m: m.output_cost_usd_1m,
					markup_pct: m.markup_pct,
					/** The markup that will be charged, in percent. */
					effective_markup_pct: resolved?.markup ?? 0,
					/**
					 * Where that markup came from: "model" is the merchant's
					 * own, "plan" is the credit system's, "none" is no
					 * markup at all.
					 */
					effective_markup_source: resolved?.source ?? "none",
					/**
					 * The markup the plan applies on its own -- what this
					 * model is charged when the merchant's own markup is
					 * unset.  The dashboard offers it as the alternative to
					 * a custom markup, so it has to be the plan's number and
					 * not a guess.
					 */
					plan_markup_pct: resolved?.planMarkup ?? 0,
					updated_at: m.updated_at,
					deployments: (byModel.get(m.model_id) ?? []).map((d) =>
						toDeploymentResponse(d),
					),
				};
			}),
		});
	},
});
