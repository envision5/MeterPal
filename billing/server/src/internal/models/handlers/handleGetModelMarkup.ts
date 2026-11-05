// GET /v1/served_models/markup?model_id=<id>
//
// The markup the org's plan applies to a model, on its own.
//
// The price sheet needs this for a model the merchant has not added yet: the
// editor offers "use your plan's markup" as an alternative to a custom one,
// and the number it names has to be the number the request path would apply.
//
// That number is not a formula the dashboard can run on its own.  A model
// the provider feed does not know, or a custom model the credit system has
// no cost for, is charged at no markup at all -- so the answer comes from
// the same resolution the request path uses.

import { isAiCreditSystem, RecaseError, ErrCode, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { getModelsDevPricing } from "@/internal/features/utils/getModelPricing.js";
import type { ModelPricingData } from "@/external/redis/actions/modelPricingCache/modelPricingCache.js";
import { resolveEffectiveMarkup } from "../resolveModelRates.js";

export const handleGetModelMarkup = createRoute({
	scopes: [Scopes.Organisation.Read],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const modelId = (c.req.query("model_id") ?? "").trim();
		if (!modelId) {
			throw new RecaseError({
				message: "A model id is required",
				code: ErrCode.InvalidRequest,
				statusCode: 400,
			});
		}

		const creditSystem = ctx.features.find((f) => isAiCreditSystem(f.type));

		// An empty feed means "no model resolves", which is what an
		// unreachable feed means to the request path too.
		const pricingData = await getModelsDevPricing().catch(
			() => ({}) as ModelPricingData,
		);

		const { planMarkup, planSource } = await resolveEffectiveMarkup({
			modelId,
			creditSystem: creditSystem ?? null,
			served: null,
			pricingData,
		});

		return c.json({
			model_id: modelId,
			plan_markup_pct: planMarkup,
			plan_markup_source: planSource,
		});
	},
});
