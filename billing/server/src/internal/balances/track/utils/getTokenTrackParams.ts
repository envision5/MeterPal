import {
	CustomerNotFoundError,
	EntityNotFoundError,
	ErrCode,
	entitlementToCreditSystem,
	type Feature,
	fullCustomerToCustomerEntitlements,
	fullSubjectToFullCustomer,
	isAiCreditSystem,
	RecaseError,
	type TrackParams,
	type TrackTokensParams,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { getOrSetCachedFullSubject } from "@/internal/customers/cache/fullSubject/actions/getOrSetCachedFullSubject.js";
import {
	getModelCreditCostBreakdown,
	getPinnedModelCostBreakdown,
} from "@/internal/features/aiCreditSystemUtils.js";
import { getServedModelPricing } from "@/internal/models/servedModelService.js";
import {
	loadPinnedQuote,
	warnQuoteMismatch,
} from "./pinnedRatesStore.js";
import type { FeatureDeduction } from "../../utils/types/featureDeduction.js";

const resolveAiCreditFeatureById = ({
	features,
	featureId,
}: {
	features: Feature[];
	featureId: string;
}): Feature => {
	const candidate = features.find((f) => f.id === featureId);
	if (!candidate) {
		throw new RecaseError({
			message: `Feature ${featureId} not found`,
			code: ErrCode.FeatureNotFound,
			statusCode: 404,
		});
	}
	if (!isAiCreditSystem(candidate.type)) {
		throw new RecaseError({
			message: `Feature ${featureId} is not an AI credit system feature`,
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}
	return candidate;
};

const isMissingSubject = (error: unknown) =>
	error instanceof CustomerNotFoundError ||
	error instanceof EntityNotFoundError;

const resolveHeldAiCreditFeatures = async ({
	ctx,
	input,
}: {
	ctx: AutumnContext;
	input: TrackTokensParams;
}): Promise<Feature[]> => {
	try {
		const fullCustomer = fullSubjectToFullCustomer({
			fullSubject: await getOrSetCachedFullSubject({
				ctx,
				customerId: input.customer_id,
				entityId: input.entity_id,
				source: "resolveAiCreditFeature",
			}),
		});
		const entity = input.entity_id
			? fullCustomer.entities?.find((e) => e.id === input.entity_id)
			: undefined;
		const cusEnts = fullCustomerToCustomerEntitlements({
			fullCustomer,
			entity,
		});

		// Deduction order: the first entitlement drains, so it sets the markup.
		const byFeatureId = new Map<string, Feature>();
		for (const ce of cusEnts) {
			const { feature } = ce.entitlement;
			if (!isAiCreditSystem(feature.type) || byFeatureId.has(feature.id))
				continue;
			byFeatureId.set(
				feature.id,
				entitlementToCreditSystem({ entitlement: ce.entitlement }),
			);
		}
		return [...byFeatureId.values()];
	} catch (error) {
		// A named feature must not block the create-customer-on-track path.
		if (input.feature_id && isMissingSubject(error)) return [];
		throw error;
	}
};

const resolveAiCreditFeature = async ({
	ctx,
	input,
}: {
	ctx: AutumnContext;
	input: TrackTokensParams;
}): Promise<Feature> => {
	const held = await resolveHeldAiCreditFeatures({ ctx, input });

	// MeterPal: pricing updates must reach EXISTING customers. The customer's
	// entitlement carries an attach-time snapshot of the credit-system
	// feature, so a newly mapped model (added to the live catalog's
	// model_markups after the customer attached) is invisible to the
	// snapshot. When the snapshot can't price the requested custom model but
	// the live catalog can, bill at the live price.
	const canPrice = (feature: Feature, modelId: string): boolean => {
		if (!modelId.startsWith("custom/")) return true;
		const entry = feature.model_markups?.[modelId];
		return entry?.input_cost != null && entry?.output_cost != null;
	};

	const pickHeld = (feature: Feature | undefined): Feature | undefined => {
		if (!feature) return undefined;
		if (canPrice(feature, input.model_id)) return feature;
		const live = ctx.features?.find((f) => f.id === feature.id);
		if (live && canPrice(live, input.model_id)) return live;
		return feature;
	};

	if (input.feature_id) {
		const heldFeature = pickHeld(
			held.find((feature) => feature.id === input.feature_id),
		);
		return (
			heldFeature ??
			resolveAiCreditFeatureById({
				features: ctx.features,
				featureId: input.feature_id,
			})
		);
	}

	if (held.length === 0) {
		throw new RecaseError({
			message: "No AI credit system feature found for this customer",
			code: ErrCode.FeatureNotFound,
			statusCode: 404,
		});
	}
	if (held.length > 1) {
		throw new RecaseError({
			message:
				"Multiple AI credit system features found for this customer. Please specify a feature_id to disambiguate.",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}
	return pickHeld(held[0])!;
};

export const getTokenTrackParams = async ({
	ctx,
	input,
}: {
	ctx: AutumnContext;
	input: TrackTokensParams;
}): Promise<{ body: TrackParams; featureDeductions: FeatureDeduction[] }> => {
	const aiCreditFeature = await resolveAiCreditFeature({ ctx, input });

	// The settle may only bill at rates the SERVER issued.  The check that
	// admitted this request stored its quote under the idempotency key; a
	// stored quote replaces whatever the caller echoed (rates AND the
	// billable model id), and with no stored quote the caller's
	// `pinned_rates` are ignored entirely — the charge is computed from the
	// org's current price sheet.  Billing caller-supplied numbers verbatim
	// is how an org key could price arbitrary usage at zero.
	const storedQuote = await loadPinnedQuote({
		ctx,
		idempotencyKey: input.idempotency_key,
	});
	if (storedQuote && input.pinned_rates) {
		const echoed = JSON.stringify(input.pinned_rates);
		const issued = JSON.stringify(storedQuote.pinned_rates);
		if (echoed !== issued || input.model_id !== storedQuote.model_id) {
			warnQuoteMismatch({
				ctx,
				idempotencyKey: input.idempotency_key,
				reason: "replaced_stored",
			});
		}
	} else if (input.pinned_rates && !storedQuote) {
		warnQuoteMismatch({
			ctx,
			idempotencyKey: input.idempotency_key,
			reason: "no_quote",
		});
	}
	const pinnedRates = storedQuote?.pinned_rates;
	const billableModelId = storedQuote?.model_id ?? input.model_id;

	// The org's own price sheet is the runtime authority for this model.
	// An org with no row for it keeps the old behaviour exactly.
	const servedModel = await getServedModelPricing({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		modelId: billableModelId,
	});

	// A pinned rate sheet means the caller was admitted at a known price:
	// use it verbatim, so a price change between admission and settlement
	// cannot move what the customer is charged.  Only the server's own
	// stored quote may appear here (see above).
	const pricing = pinnedRates
		? getPinnedModelCostBreakdown({
				rates: pinnedRates,
				input: input.input_tokens,
				output: input.output_tokens,
				cacheRead: input.cache_read_tokens,
				cacheWrite: input.cache_write_tokens,
				audioInput: input.audio_input_tokens,
				audioOutput: input.audio_output_tokens,
				reasoning: input.reasoning_tokens,
			})
		: await getModelCreditCostBreakdown({
				modelName: billableModelId,
				creditSystem: aiCreditFeature,
				servedModel,
				input: input.input_tokens,
				output: input.output_tokens,
				cacheRead: input.cache_read_tokens,
				cacheWrite: input.cache_write_tokens,
				audioInput: input.audio_input_tokens,
				audioOutput: input.audio_output_tokens,
				reasoning: input.reasoning_tokens,
			});
	const cost = pricing.cost;

	const featureDeductions: FeatureDeduction[] = [
		{
			feature: aiCreditFeature,
			deduction: 1,
			tokens: {
				usage: {
					modelName: billableModelId,
					inputTokens: input.input_tokens,
					outputTokens: input.output_tokens,
				},
				cost,
			},
		},
	];

	const body: TrackParams = {
		customer_id: input.customer_id,
		entity_id: input.entity_id,
		feature_id: aiCreditFeature.id,
		value: cost,
		properties: {
			...input.properties,
			model: billableModelId,
			input_tokens: input.input_tokens,
			output_tokens: input.output_tokens,
			cache_read_tokens: input.cache_read_tokens,
			cache_write_tokens: input.cache_write_tokens,
			audio_input_tokens: input.audio_input_tokens,
			audio_output_tokens: input.audio_output_tokens,
			reasoning_tokens: input.reasoning_tokens,
			cost,
			base_cost: pricing.baseCost,
			markup: pricing.markup,
			markup_source: pricing.markupSource,
			tier_applied: pricing.tierApplied,
			rates: {
				input: pricing.rates.input,
				output: pricing.rates.output,
				cache_read: pricing.rates.cacheRead,
				cache_write: pricing.rates.cacheWrite,
				audio_input: pricing.rates.audioInput,
				audio_output: pricing.rates.audioOutput,
				reasoning: pricing.rates.reasoning,
			},
		},
		idempotency_key: input.idempotency_key,
		overage_behavior: input.overage_behavior,
		customer_data: input.customer_data,
		entity_data: input.entity_data,
		skip_event: input.skip_event,
		timestamp: input.timestamp,
		async: input.async,
	};

	return { body, featureDeductions };
};
