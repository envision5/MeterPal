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
//
// A catalog entry also carries what its instance would be configured with:
// the gateway's provider prefix, the provider's base URL, and the input
// modalities it accepts. That is the difference between "add a model" and
// "add a model, then work out what to type in four more fields" — the
// merchant should be able to add a model by pasting a key.

import { isAiCreditSystem } from "@autumn/shared";
import { Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { getModelsDevPricing } from "@/internal/features/utils/getModelPricing.js";
import { isBillableModelCost } from "@/internal/features/utils/isBillableModelCost.js";
import {
	litellmProviderFor,
	modalitiesFromCatalog,
	splitProviderModel,
} from "../providerProtocol.js";
import { listServedModels } from "../servedModelService.js";

type AvailableModel = {
	model_id: string;
	display_name: string | null;
	provider_input_cost_usd_1m: number | null;
	provider_output_cost_usd_1m: number | null;
	source: "provider" | "custom" | "served";
	/** The catalog provider's display name, for "served by 302.AI". */
	provider_name: string | null;
	/** What an instance of this model is called on the gateway. */
	provider_model: string | null;
	/** The provider's base URL; null when the SDK already knows it. */
	api_base: string | null;
	/** Input modalities the model accepts, minus text. Null when the
	 *  catalog does not say, which is not the same as "text only". */
	modalities: string[] | null;
};

export const handleGetAvailableModels = createRoute({
	scopes: [Scopes.Organisation.Read],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { org, env } = ctx;

		const available = new Map<string, AvailableModel>();

		// 1. The provider catalog.
		try {
			const pricing = await getModelsDevPricing();
			for (const [provider, providerData] of Object.entries(pricing)) {
				for (const [modelKey, model] of Object.entries(
					providerData.models ?? {},
				)) {
					if (!isBillableModelCost(model.cost)) continue;

					const modelId = `${provider}/${modelKey}`;
					// The catalog's provider id is not necessarily the
					// gateway's: `302ai/claude-fable-5` is served as
					// `openai/claude-fable-5`, and `claude/` is served by
					// nobody at all.
					const prefix = litellmProviderFor({
						providerId: provider,
						npm: providerData.npm,
					});

					available.set(modelId, {
						model_id: modelId,
						display_name: model.name ?? modelKey,
						provider_input_cost_usd_1m: model.cost.input,
						provider_output_cost_usd_1m: model.cost.output,
						source: "provider",
						provider_name: providerData.name ?? provider,
						provider_model: `${prefix}/${modelKey}`,
						api_base: providerData.api ?? null,
						modalities: model.modalities?.input
							? modalitiesFromCatalog(model.modalities.input)
							: null,
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
				provider_name: null,
				// A custom model has no provider behind its id, but its
				// instance almost always speaks OpenAI. The merchant still
				// has to supply the base URL — there is nowhere to read one.
				provider_model: `openai/${splitProviderModel(modelId)?.modelKey ?? modelId}`,
				api_base: null,
				modalities: null,
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
				provider_name: existing?.provider_name ?? null,
				provider_model: existing?.provider_model ?? null,
				api_base: existing?.api_base ?? null,
				modalities: existing?.modalities ?? null,
			});
		}

		return c.json({
			models: [...available.values()].sort((a, b) =>
				a.model_id.localeCompare(b.model_id),
			),
		});
	},
});
