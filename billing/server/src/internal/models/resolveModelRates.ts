// billing/server/src/internal/models/resolveModelRates.ts
//
// One place that answers "what does this model cost this org right now?".
//
// The check call and the track call must agree, or a merchant who changes a
// price between admission and settlement gets charged a price nobody quoted.
// So both sides go through this module: the check resolves the rates and
// pins them into its response, and the track uses the pinned rates verbatim
// when they are supplied.

import { AppEnv, type Feature } from "@autumn/shared";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import {
	getModelCreditCostBreakdown,
	type ModelCostBreakdown,
} from "@/internal/features/aiCreditSystemUtils.js";
import type { ModelPricingData } from "@/external/redis/actions/modelPricingCache/modelPricingCache.js";
import {
	getServedModelPricing,
	pricingFromRow,
	type ServedModelPricing,
} from "./servedModelService.js";

/** The unit rates a request is charged at, in USD per 1M tokens. */
export type PinnedModelRates = {
	input: number;
	output: number;
	cache_read?: number;
	cache_write?: number;
	audio_input?: number;
	audio_output?: number;
	reasoning?: number;
	/** The markup already folded into the charge, in percent. */
	markup: number;
};

/** Where a markup number came from. */
export type MarkupSource = ModelCostBreakdown["markupSource"];

/**
 * The markup a model is charged at, and where that number came from.
 *
 * This is the same answer `resolveModelRates` gives, reached without
 * re-reading the row and without the cost computation -- so the price sheet
 * can resolve a whole sheet of models in one pass and show the merchant the
 * number that will actually be charged.
 *
 * The merchant's own markup wins, and only when their row is the authority:
 * a row with no usable prices is no opinion, so the plan's markup applies
 * then, exactly as it would at request time.
 *
 * `planMarkup` is the markup the plan applies on its own -- the number a
 * merchant gets when they put their model's markup back to "inherit the
 * plan's".  The dashboard shows it as the alternative to a custom markup,
 * so it has to come from the same resolution the runtime uses.
 */
export const resolveEffectiveMarkup = async ({
	modelId,
	creditSystem,
	served,
	pricingData,
}: {
	modelId: string;
	creditSystem: Feature | null;
	served: ServedModelPricing | null;
	pricingData?: ModelPricingData;
}): Promise<{
	markup: number;
	source: "model" | "plan" | "none";
	planMarkup: number;
	planSource: MarkupSource;
}> => {
	if (!creditSystem) {
		return {
			markup: 0,
			source: "none",
			planMarkup: 0,
			planSource: "none",
		};
	}

	const fallback = await resolveFeatureRates({
		modelId,
		creditSystem,
		pricingData,
	});
	const planMarkup = fallback?.markup ?? 0;
	const planSource = fallback?.markupSource ?? "none";

	if (served?.markupPct != null) {
		return {
			markup: served.markupPct,
			source: "model",
			planMarkup,
			planSource,
		};
	}

	return {
		markup: planMarkup,
		source: planSource === "none" ? "none" : "plan",
		planMarkup,
		planSource,
	};
};

/**
 * The rates for a model, or null when the model cannot be priced.
 *
 * The org's own `served_models` row wins: it is the merchant's price sheet,
 * and it is not affected by a models.dev change.  Without a row, the provider
 * price applies, exactly as before this table existed.
 */
export const resolveModelRates = async ({
	db,
	orgId,
	env,
	modelId,
	creditSystem,
	pricingData,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
	modelId: string;
	creditSystem: Feature;
	/** The provider feed, when the caller already has it. */
	pricingData?: ModelPricingData;
}): Promise<PinnedModelRates | null> => {
	const served = await getServedModelPricing({ db, orgId, env, modelId });
	if (served) {
		// The merchant's markup wins when they set one; otherwise the plan's
		// markup still applies, so listing a model never drops the margin.
		const { markup } = await resolveEffectiveMarkup({
			modelId,
			creditSystem,
			served,
			pricingData,
		});
		return {
			input: served.input,
			output: served.output,
			cache_read: served.input,
			cache_write: served.input,
			audio_input: served.input,
			audio_output: served.output,
			reasoning: served.output,
			markup,
		};
	}

	return resolveFeatureRates({ modelId, creditSystem, pricingData });
};

/**
 * The rates from the provider price (models.dev) or the feature's custom
 * model pricing.  Returns null when the model has no price at all.
 */
const resolveFeatureRates = async ({
	modelId,
	creditSystem,
	pricingData,
}: {
	modelId: string;
	creditSystem: Feature;
	pricingData?: ModelPricingData;
}): Promise<(PinnedModelRates & { markupSource: MarkupSource }) | null> => {
	try {
		const breakdown = await getModelCreditCostBreakdown({
			modelName: modelId,
			creditSystem,
			pricingData,
			input: 0,
			output: 0,
		});
		return {
			input: breakdown.rates.input,
			output: breakdown.rates.output,
			cache_read: breakdown.rates.cacheRead,
			cache_write: breakdown.rates.cacheWrite,
			audio_input: breakdown.rates.audioInput,
			audio_output: breakdown.rates.audioOutput,
			reasoning: breakdown.rates.reasoning,
			markup: breakdown.markup,
			markupSource: breakdown.markupSource,
		};
	} catch {
		// An unpriceable model is not a crash: the caller decides what to do
		// (the track path surfaces the original pricing error).
		return null;
	}
};

/**
 * The pricing a row states, or null when the row states none.
 *
 * Re-exported here so the price sheet resolves a sheet of rows without
 * reaching into two modules for the same idea.
 */
export { pricingFromRow };
