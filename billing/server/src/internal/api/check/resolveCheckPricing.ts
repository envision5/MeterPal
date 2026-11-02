// billing/server/src/internal/api/check/resolveCheckPricing.ts
//
// The pricing a check call pins for the caller.
//
// A check says "may this customer make this call?" and the settle says "here
// is what it cost".  If the two resolve the price independently, a merchant
// who edits a price between the two calls gets a charge nobody quoted.  The
// check therefore resolves the rates once and hands them to the caller, and
// the settle uses those rates verbatim.

import { isAiCreditSystem } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { getPinnedModelCostBreakdown } from "@/internal/features/aiCreditSystemUtils.js";
import { resolveModelRates } from "@/internal/models/resolveModelRates.js";

export type CheckPricing = {
	/** The unit rates the caller is admitted at, in USD per 1M tokens. */
	pinned_rates: {
		input: number;
		output: number;
		cache_read?: number;
		cache_write?: number;
		audio_input?: number;
		audio_output?: number;
		reasoning?: number;
		markup: number;
	};
	/** What the request is expected to cost at those rates. */
	estimated_cost: number;
};

/**
 * The pricing for a model, or null when the request did not name one.
 *
 * Null is a normal outcome: a check without a model_id is a plain balance
 * check, and a model that cannot be priced must not fail the admission.
 */
export const resolveCheckPricing = async ({
	ctx,
	modelId,
	inputTokens,
	outputTokens,
	featureId,
}: {
	ctx: AutumnContext;
	modelId?: string;
	inputTokens?: number;
	outputTokens?: number;
	featureId?: string;
}): Promise<CheckPricing | null> => {
	if (!modelId) return null;

	// The AI credit feature carries the markup.  The check does not resolve
	// the customer's entitlements (the track path does that), so the org's
	// feature is used: with one AI credit system per org, which is the norm.
	const creditSystem =
		(featureId ? ctx.features.find((f) => f.id === featureId) : undefined) ??
		ctx.features.find((f) => isAiCreditSystem(f.type));
	if (!creditSystem || !isAiCreditSystem(creditSystem.type)) return null;

	const rates = await resolveModelRates({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		modelId,
		creditSystem,
	});
	if (!rates) return null;

	const breakdown = getPinnedModelCostBreakdown({
		rates,
		input: inputTokens ?? 0,
		output: outputTokens ?? 0,
	});

	return {
		pinned_rates: rates,
		estimated_cost: breakdown.cost,
	};
};
