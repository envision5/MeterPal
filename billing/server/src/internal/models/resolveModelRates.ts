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
import { getModelCreditCostBreakdown } from "@/internal/features/aiCreditSystemUtils.js";
import { getServedModelPricing } from "./servedModelService.js";

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
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
	modelId: string;
	creditSystem: Feature;
}): Promise<PinnedModelRates | null> => {
	const served = await getServedModelPricing({ db, orgId, env, modelId });
	if (served) {
		// The merchant's markup wins when they set one; otherwise the plan's
		// markup still applies, so listing a model never drops the margin.
		let markup = served.markupPct;
		if (markup == null) {
			const fallback = await resolveFeatureRates({
				modelId,
				creditSystem,
			});
			markup = fallback?.markup ?? 0;
		}
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

	return resolveFeatureRates({ modelId, creditSystem });
};

/**
 * The rates from the provider price (models.dev) or the feature's custom
 * model pricing.  Returns null when the model has no price at all.
 */
const resolveFeatureRates = async ({
	modelId,
	creditSystem,
}: {
	modelId: string;
	creditSystem: Feature;
}): Promise<PinnedModelRates | null> => {
	try {
		const breakdown = await getModelCreditCostBreakdown({
			modelName: modelId,
			creditSystem,
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
		};
	} catch {
		// An unpriceable model is not a crash: the caller decides what to do
		// (the track path surfaces the original pricing error).
		return null;
	}
};
