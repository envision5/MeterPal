// GET /v1/served_models/available
//
// The models a merchant can pick from.
//
// Three sources, merged:
//
//   1. the provider catalog (models.dev) — the models MeterPal can serve
//   2. the org's own custom models (the AI credit feature's model_markups)
//   3. the org's existing rows, so a model that is listed but no longer in
//      the catalog is still visible and can be removed
//
// The costs returned here are the PROVIDER's costs — the baseline the
// merchant's own price is compared against for the margin preview.  The
// merchant's own prices live in GET /v1/served_models and are never mixed
// in here: a served row must not make the provider's price look like the
// merchant's.

import { isAiCreditSystem, splitModelId } from "@autumn/shared";
import { Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { getModelsDevPricing } from "@/internal/features/utils/getModelPricing.js";
import { isBillableModelCost } from "@/internal/features/utils/isBillableModelCost.js";
import { listServedModels } from "../servedModelService.js";

export const handleGetAvailableModels = createRoute({
	scopes: [Scopes.Organisation.Read],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { org, env } = ctx;

		const available = new Map<
			string,
			{
				model_id: string;
				display_name: string | null;
				provider_input_cost_usd_1m: number | null;
				provider_output_cost_usd_1m: number | null;
				source: "provider" | "custom" | "served";
			}
		>();

		// 1. The provider catalog.
		try {
			const pricing = await getModelsDevPricing();
			for (const [provider, providerData] of Object.entries(pricing)) {
				for (const [modelKey, model] of Object.entries(
					providerData.models ?? {},
				)) {
					if (!isBillableModelCost(model.cost)) continue;
					available.set(`${provider}/${modelKey}`, {
						model_id: `${provider}/${modelKey}`,
						display_name: model.name ?? modelKey,
						provider_input_cost_usd_1m: model.cost.input,
						provider_output_cost_usd_1m: model.cost.output,
						source: "provider",
					});
				}
			}
		} catch {
			// The provider feed is a convenience: the custom models and the
			// org's own rows are still listed without it.
		}

		// 2. The org's custom models.  The feature's cost is the baseline for
		//    a custom model — there is no provider price for one.
		const aiCreditFeature = ctx.features.find((f) => isAiCreditSystem(f.type));
		for (const [modelId, entry] of Object.entries(
			aiCreditFeature?.model_markups ?? {},
		)) {
			if (!modelId.startsWith("custom/")) continue;
			available.set(modelId, {
				model_id: modelId,
				display_name: null,
				provider_input_cost_usd_1m: entry?.input_cost ?? null,
				provider_output_cost_usd_1m: entry?.output_cost ?? null,
				source: "custom",
			});
		}

		// 3. The org's own rows, so a model it lists stays visible even if it
		//    is no longer in the provider catalog.
		const served = await listServedModels({ db: ctx.db, orgId: org.id, env });
		for (const row of served) {
			const existing = available.get(row.model_id);
			available.set(row.model_id, {
				model_id: row.model_id,
				display_name: row.display_name ?? existing?.display_name ?? null,
				provider_input_cost_usd_1m:
					existing?.provider_input_cost_usd_1m ?? null,
				provider_output_cost_usd_1m:
					existing?.provider_output_cost_usd_1m ?? null,
				source: "served",
			});
		}

		return c.json({
			models: [...available.values()].sort((a, b) =>
				a.model_id.localeCompare(b.model_id),
			),
		});
	},
});
