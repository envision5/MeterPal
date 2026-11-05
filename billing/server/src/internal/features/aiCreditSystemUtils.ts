import {
	ErrCode,
	type Feature,
	isCustomModel,
	type ModelsDevCost,
	type ModelsDevCostTier,
	type ModelsDevModel,
	type ModelsDevProvider,
	RecaseError,
	splitModelId,
} from "@autumn/shared";
import { Decimal } from "decimal.js";
import type { ServedModelPricing } from "@/internal/models/servedModelService.js";
import { getModelsDevPricing } from "@/internal/features/utils/getModelPricing.js";
import { isBillableModelCost } from "@/internal/features/utils/isBillableModelCost.js";

export type TokenInput = {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	audioInput?: number;
	audioOutput?: number;
	reasoning?: number;
};

type ModelPricingData = Record<string, ModelsDevProvider>;

const LARGE_CONTEXT_THRESHOLD = 200_000;

type ResolvedModel =
	| { custom: true }
	| {
			custom: false;
			providerKey: string;
			modelKey: string;
			model: ModelsDevModel;
	  };

const modelNotFoundError = (modelName: string) =>
	new RecaseError({
		message: `Model ${modelName} not found in models.dev pricing data`,
		code: ErrCode.InvalidRequest,
		statusCode: 400,
		data: { modelName },
	});

const unsupportedPricingError = (modelName: string) =>
	new RecaseError({
		message: `Model ${modelName} uses a models.dev pricing structure MeterPal can't bill yet. Use a custom/ model with input_cost and output_cost in model_markups instead.`,
		code: ErrCode.InvalidRequest,
		statusCode: 400,
		data: { modelName },
	});

/**
 * Resolve a `model_id` to a models.dev entry by exact `<provider>/<model>` lookup. The id is
 * split on the first `/` (so openrouter slugs like `openrouter/openai/gpt-4o` keep their inner
 * `/`); the model key must match a models.dev entry exactly. `custom/` models skip resolution.
 */
const resolveModel = ({
	modelName,
	pricingData,
}: {
	modelName: string;
	pricingData: ModelPricingData;
}): ResolvedModel => {
	if (isCustomModel(modelName)) {
		return { custom: true };
	}

	const { provider, modelKey } = splitModelId(modelName);
	const model = provider ? pricingData[provider]?.models[modelKey] : undefined;
	if (!(provider && model)) {
		throw modelNotFoundError(modelName);
	}
	if (!isBillableModelCost(model.cost)) {
		throw unsupportedPricingError(modelName);
	}

	return { custom: false, providerKey: provider, modelKey, model };
};

/**
 * Resolve the effective per-token rates for a request, overlaying the active long-context
 * tier (or `context_over_200k`) onto the base rates. Tier-level cache, audio-input, and
 * reasoning rates override the base rates when present, not just input/output.
 */
const getEffectiveCost = (
	cost: ModelsDevCost,
	totalInputTokens: number,
): { effective: ModelsDevCost; tierApplied: boolean } => {
	if (cost.tiers?.length) {
		let chosen: ModelsDevCostTier | undefined;
		for (const tier of cost.tiers) {
			if (
				totalInputTokens > tier.tier.size &&
				(!chosen || tier.tier.size > chosen.tier.size)
			) {
				chosen = tier;
			}
		}
		if (chosen) {
			return {
				effective: {
					...cost,
					input: chosen.input,
					output: chosen.output,
					cache_read: chosen.cache_read ?? cost.cache_read,
					cache_write: chosen.cache_write ?? cost.cache_write,
					input_audio: chosen.input_audio ?? cost.input_audio,
					reasoning: chosen.reasoning ?? cost.reasoning,
				},
				tierApplied: true,
			};
		}
		return { effective: cost, tierApplied: false };
	}
	if (cost.context_over_200k && totalInputTokens > LARGE_CONTEXT_THRESHOLD) {
		return {
			effective: {
				...cost,
				input: cost.context_over_200k.input,
				output: cost.context_over_200k.output,
				cache_read: cost.context_over_200k.cache_read ?? cost.cache_read,
				cache_write: cost.context_over_200k.cache_write ?? cost.cache_write,
			},
			tierApplied: true,
		};
	}
	return { effective: cost, tierApplied: false };
};

/** Effective per-token rates ($/M) used for a charge, after tier overlays and fallbacks. */
export type ModelCostRates = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	audioInput: number;
	audioOutput: number;
	reasoning: number;
};

export type ModelCostBreakdown = {
	cost: number;
	baseCost: number;
	markup: number;
	markupSource: "model" | "provider" | "default" | "none" | "pinned";
	tierApplied: boolean;
	rates: ModelCostRates;
};

const computeCost = ({
	cost,
	tokens,
	markup,
}: {
	cost: ModelsDevCost;
	tokens: TokenInput;
	markup: number;
}): {
	cost: number;
	baseCost: number;
	tierApplied: boolean;
	rates: ModelCostRates;
} => {
	const cacheRead = tokens.cacheRead ?? 0;
	const cacheWrite = tokens.cacheWrite ?? 0;
	const audioInput = tokens.audioInput ?? 0;
	const audioOutput = tokens.audioOutput ?? 0;
	const reasoning = tokens.reasoning ?? 0;

	const totalInput = tokens.input + cacheRead + cacheWrite;
	const { effective, tierApplied } = getEffectiveCost(cost, totalInput);

	// Pools without a published rate fall back to the base text rate.
	const rates: ModelCostRates = {
		input: effective.input,
		output: effective.output,
		cacheRead: effective.cache_read ?? effective.input,
		cacheWrite: effective.cache_write ?? effective.input,
		audioInput: effective.input_audio ?? effective.input,
		audioOutput: effective.output_audio ?? effective.output,
		reasoning: effective.reasoning ?? effective.output,
	};

	const baseCost = new Decimal(rates.input)
		.mul(tokens.input)
		.add(new Decimal(rates.output).mul(tokens.output))
		.add(new Decimal(rates.cacheRead).mul(cacheRead))
		.add(new Decimal(rates.cacheWrite).mul(cacheWrite))
		.add(new Decimal(rates.audioInput).mul(audioInput))
		.add(new Decimal(rates.audioOutput).mul(audioOutput))
		.add(new Decimal(rates.reasoning).mul(reasoning))
		.div(1_000_000);

	return {
		cost: baseCost
			.mul(new Decimal(1).add(new Decimal(markup).div(100)))
			.toNumber(),
		baseCost: baseCost.toNumber(),
		tierApplied,
		rates,
	};
};

/**
 * The markup chain for a model: the model's own markup, else its provider's,
 * else the credit system's default, else none.
 *
 * Exported because the price sheet has to show the same number the request
 * path will charge at -- a dashboard that resolves markup its own way drifts
 * from the runtime, and the merchant sees a price that is not the one they
 * are billed.
 */
export const resolveAiMarkup = ({
	modelName,
	creditSystem,
	modelMarkup,
}: {
	modelName: string;
	creditSystem: Feature;
	modelMarkup?: { markup?: number | null } | null;
}): { markup: number; source: ModelCostBreakdown["markupSource"] } => {
	if (modelMarkup?.markup != null) {
		return { markup: modelMarkup.markup, source: "model" };
	}

	const { provider } = splitModelId(modelName);
	const providerMarkup = provider
		? creditSystem.config?.provider_markups?.[provider]?.markup
		: undefined;
	if (providerMarkup != null) {
		return { markup: providerMarkup, source: "provider" };
	}

	const defaultMarkup = creditSystem.config?.default_markup;
	if (defaultMarkup != null) {
		return { markup: defaultMarkup, source: "default" };
	}

	return { markup: 0, source: "none" };
};

export const getModelCreditCostBreakdown = async ({
	modelName,
	creditSystem,
	servedModel,
	pricingData,
	...tokens
}: {
	modelName: string;
	creditSystem: Feature;
	/**
	 * The org's own price for this model, from `served_models`.
	 *
	 * When present it is the runtime authority: a models.dev change cannot
	 * move the merchant's price, and the merchant's markup wins over the
	 * plan's (unless the merchant left it unset, in which case the plan's
	 * markup still applies).  When absent, nothing changes.
	 */
	servedModel?: ServedModelPricing | null;
	/**
	 * The provider feed, when the caller already has it.
	 *
	 * Reading the feed parses a large payload, so a caller resolving many
	 * models reads it once and passes it in rather than paying for it per
	 * model.  Omitted, the feed is read here.
	 */
	pricingData?: ModelPricingData;
} & TokenInput): Promise<ModelCostBreakdown> => {
	const markups = creditSystem.model_markups || {};
	const resolved = resolveModel({
		modelName,
		pricingData: pricingData ?? (await getModelsDevPricing()),
	});

	const markupEntry = markups[modelName];
	const featureMarkup = resolveAiMarkup({
		modelName,
		creditSystem,
		modelMarkup: markupEntry,
	});

	// The org's price sheet wins for both the base rate and the markup.
	if (servedModel) {
		const { markup, source } =
			servedModel.markupPct != null
				? { markup: servedModel.markupPct, source: "model" as const }
				: featureMarkup;

		// Cache, audio, and reasoning pools are not separately priced on the
		// merchant's sheet, so they fall back to the text rates.
		const computed = computeCost({
			cost: {
				input: servedModel.input,
				output: servedModel.output,
				cache_read: servedModel.input,
				cache_write: servedModel.input,
				input_audio: servedModel.input,
				output_audio: servedModel.output,
				reasoning: servedModel.output,
			},
			tokens,
			markup,
		});
		return { ...computed, markup, markupSource: source };
	}

	const { markup, source } = featureMarkup;

	// Custom models carry no models.dev rates; they bill input/output at the user-supplied
	// costs only (cache/audio/reasoning pools are not priced for custom models).
	if (resolved.custom) {
		if (markupEntry?.input_cost == null || markupEntry?.output_cost == null) {
			throw new RecaseError({
				message: `Custom model ${modelName} is missing input_cost or output_cost in model_markups`,
				code: ErrCode.InvalidRequest,
				data: { modelName },
			});
		}
		const computed = computeCost({
			cost: { input: markupEntry.input_cost, output: markupEntry.output_cost },
			tokens: { input: tokens.input, output: tokens.output },
			markup,
		});
		return { ...computed, markup, markupSource: source };
	}

	const computed = computeCost({
		cost: resolved.model.cost,
		tokens,
		markup,
	});
	return { ...computed, markup, markupSource: source };
};

export const getModelCreditCost = async (
	args: { modelName: string; creditSystem: Feature } & TokenInput,
): Promise<number> => (await getModelCreditCostBreakdown(args)).cost;

/**
 * The cost of a request at rates that were pinned earlier.
 *
 * Used when the caller settled at a price it was admitted at: the merchant's
 * price sheet may have changed in between, and the charge must still be the
 * one that was quoted.  No price lookup happens here at all — which is
 * exactly why the rates are validated hard: a negative or non-finite rate
 * would mint or destroy balance through the deduction.
 */
export const getPinnedModelCostBreakdown = ({
	rates,
	...tokens
}: {
	rates: {
		input: number;
		output: number;
		cache_read?: number;
		cache_write?: number;
		audio_input?: number;
		audio_output?: number;
		reasoning?: number;
		markup: number;
	};
} & TokenInput): ModelCostBreakdown => {
	const rateValues = [
		rates.input,
		rates.output,
		rates.cache_read,
		rates.cache_write,
		rates.audio_input,
		rates.audio_output,
		rates.reasoning,
		rates.markup,
	];
	if (
		!rateValues.every(
			(v) => v === undefined || (Number.isFinite(v) && v >= 0),
		)
	) {
		throw new RecaseError({
			message:
				"pinned_rates must be finite, non-negative numbers. The server only honors rates it issued at check time.",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}
	const computed = computeCost({
		cost: {
			input: rates.input,
			output: rates.output,
			cache_read: rates.cache_read ?? rates.input,
			cache_write: rates.cache_write ?? rates.input,
			input_audio: rates.audio_input ?? rates.input,
			output_audio: rates.audio_output ?? rates.output,
			reasoning: rates.reasoning ?? rates.output,
		},
		tokens,
		markup: rates.markup,
	});
	return { ...computed, markup: rates.markup, markupSource: "pinned" };
};
