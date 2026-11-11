// billing/server/src/internal/studio/handleStudioAi.ts
//
// POST /studio/ai
//
// One metered turn of AG Studio's agent loop.
//
// AG Studio never talks to a model provider itself: the app supplies an
// `AgLlmAdapter`, and the adapter calls this route. The call goes through the
// same inference path as every other metered completion in this server --
// resolve the model, resolve the wallet being billed, mint that wallet's
// gateway key, forward to the gateway, and settle the charge.
//
// WHOSE WALLET. The turn is the merchant working on their own dashboard, so
// it bills the merchant's console wallet (`meterpal-console`), never the end
// user the dashboard happens to be showing. The end user's id travels in
// `scope_customer_id` and does nothing but say which slice of usage is on
// screen -- it is data, not a payer. See `studioWallet.ts` for why.
//
// The consequence, which is the point: a merchant exploring their own
// analytics cannot spend a customer's credits, cannot move a customer's
// balance, and cannot paywall a customer by using the console. Console spend
// is the merchant's own line item, visible in their own customer list.

import { Scopes } from "@autumn/shared";
import type { Context } from "hono";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import {
	GatewayError,
	ModelNotFoundError,
} from "@/internal/inference/inferenceErrors.js";
import {
	buildGatewayPayload,
	callGateway,
	getOrProvisionVirtualKey,
	resolveInferenceModel,
	settleMeterpalBlock,
} from "@/internal/inference/inferenceService.js";
import { litellmFeatureId } from "@/internal/keys/litellmEnv.js";
import { listServedModels } from "@/internal/models/servedModelService.js";
import { getFeatureBalance } from "@/internal/inference/usageSettlement.js";
import {
	openAiCompletionToStudioResponse,
	studioRequestToOpenAiMessages,
	studioResponseFormatToOpenAi,
	studioToolChoiceToOpenAi,
	studioToolsToOpenAiTools,
	type OpenAiChatCompletion,
	type StudioLlmRequest,
} from "./llmProtocol.js";
import { ensureStudioWallet } from "./studioWallet.js";

const StudioAiSchema = z.object({
	/**
	 * The end user whose usage the dashboard is looking at. Scope only:
	 * it selects what the assistant is talking about and is never billed.
	 */
	scope_customer_id: z.string().min(1).optional(),
	/** The model to run. Defaults to the org's first enabled served model. */
	model: z.string().optional(),
	/** AG Studio's `AgLlmRequest`. */
	request: z.object({}).passthrough().optional(),
});

/**
 * The output ceiling for one studio turn.
 *
 * Admission reserves the WORST CASE: input plus the output cap, priced at the
 * org's sheet.  With no `max_tokens` on the request, the gateway reserves
 * against its own 8192-token ceiling -- on a $20/M-out model that is a ~0.66
 * credit hold per turn, per prompt, before a single token is generated.  A
 * studio turn is a tool call and a sentence or two, so a cap cuts the hold.
 *
 * 4096, not 2048.  The model reasons before it acts, and the reasoning counts
 * against this ceiling: at 2048 a step that thought for a while before calling
 * `complete_task` had its tool arguments cut off, which surfaced as a widget
 * agent that "finished without a summary" -- intermittently, depending on how
 * much it had thought.  Doubling the ceiling halves the reservation headroom
 * per turn (250 credits is still ~190 turns) and removes a failure that looked
 * like the agent being lazy.
 *
 * This is a reservation bound, not a bill: the charge is the tokens actually
 * used, and a turn that stops early costs less than the hold.
 */
const STUDIO_MAX_OUTPUT_TOKENS = Number(
	process.env.STUDIO_MAX_OUTPUT_TOKENS ?? 4096,
);

/**
 * The model a studio turn runs on when the caller names none.
 *
 * The org's own price sheet is the authority: whatever the merchant sells is
 * what their dashboard assistant runs on, so a merchant who swaps models in
 * the dashboard swaps the assistant's model too, with no config here. Only an
 * org that has listed nothing falls back to the demo default -- and that org
 * has nothing to sell either, so the refusal is explicit rather than a
 * gateway 403 naming a model the key was never allowed to call.
 */
const defaultStudioModel = async ({
	ctx,
}: {
	ctx: AutumnContext;
}): Promise<string> => {
	const rows = await listServedModels({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
	});
	const enabled = rows
		.filter((row) => row.enabled && row.model_id)
		.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));

	// The demo's configured model wins when the org sells it, so a studio turn
	// and the rest of the demo stay on the same model.
	const preferred = process.env.STUDIO_DEFAULT_MODEL;
	if (preferred && enabled.some((row) => row.model_id === preferred)) {
		return preferred;
	}
	if (enabled[0]) return enabled[0].model_id;

	throw new ModelNotFoundError({ model: "any (no model is served here)" });
};

export const handleStudioAi = createRoute({
	scopes: [Scopes.Billing.Write],
	body: StudioAiSchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { scope_customer_id, model, request } = c.req.valid("json");

		const studioRequest = (request ?? {}) as StudioLlmRequest;

		// Which model? An explicit one wins; otherwise the org's own sheet.
		const modelId =
			model ??
			studioRequest.model?.id ??
			(await defaultStudioModel({ ctx }));

		const resolvedModel = await resolveInferenceModel({ ctx, model: modelId });

		// The payer. Always the merchant's console wallet -- never the customer
		// being viewed, which is why the request cannot name it.
		const wallet = await ensureStudioWallet({ ctx });

		const virtualKey = await getOrProvisionVirtualKey({ ctx, customer: wallet });

		const messages = studioRequestToOpenAiMessages({ request: studioRequest });
		const tools = studioToolsToOpenAiTools({ tools: studioRequest.tools });
		const toolChoice = studioToolChoiceToOpenAi({
			toolChoice: studioRequest.toolChoice,
		});
		const responseFormat = studioResponseFormatToOpenAi({
			responseFormat: studioRequest.responseFormat,
		});

		const callId = crypto.randomUUID();
		const payload = buildGatewayPayload({
			body: {
				model: modelId,
				messages,
				// Bound the reservation, not the bill.  See
				// STUDIO_MAX_OUTPUT_TOKENS.
				max_tokens: STUDIO_MAX_OUTPUT_TOKENS,
				...(tools ? { tools } : {}),
				...(toolChoice ? { tool_choice: toolChoice } : {}),
				...(responseFormat ? { response_format: responseFormat } : {}),
			},
			resolvedModel,
			customerId: wallet.id,
		});

		const gatewayResponse = await callGateway({
			virtualKey,
			callId,
			payload,
		});

		if (!gatewayResponse.ok) {
			return await respondWithGatewayError({
				c,
				ctx,
				response: gatewayResponse,
			});
		}

		const completion = (await gatewayResponse.json()) as OpenAiChatCompletion;
		const meterpal = await settleMeterpalBlock({
			ctx,
			customer: wallet,
			callId,
		});

		const studioResponse = openAiCompletionToStudioResponse({
			completion,
			fallbackId: callId,
			// The same schemas the turn was sent with. Studio executes its own
			// tools client-side, so a call it cannot parse fails where this
			// server cannot see it -- the schemas let the reply be repaired
			// before it gets there.
			tools: studioRequest.tools,
		});

		ctx.logger.info("AG Studio agent turn metered", {
			orgId: ctx.org.id,
			// Who paid, and what the turn was about. These must never be the
			// same thing: the first is the merchant, the second is their user.
			walletCustomerId: wallet.id,
			scopeCustomerId: scope_customer_id ?? null,
			model: resolvedModel.billableModelId,
			creditsCharged: meterpal.credits_charged,
			toolCalls: studioResponse.output.filter(
				(item) => item.type === "function_call",
			).length,
		});

		return c.json({
			...studioResponse,
			// What the turn cost, so the UI can show it and the demo can prove
			// the agent is metered -- against the merchant's wallet.
			meterpal,
		});
	},
});

/**
 * Turn a gateway refusal into the answer the dashboard expects.
 *
 * A 402 is the paywall: the console wallet cannot cover the turn, so the
 * agent cannot run. That is a first-class outcome here, not an error -- it is
 * the product working. It is also strictly the merchant's own balance: an
 * empty console says nothing about any end user, and the message says so.
 */
const respondWithGatewayError = async ({
	c,
	ctx,
	response,
}: {
	c: Context<HonoEnv>;
	ctx: AutumnContext;
	response: Response;
}) => {
	const text = await response.text();
	let parsed: unknown = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = null;
	}

	const detail =
		(parsed as { detail?: unknown })?.detail ??
		(parsed as { error?: unknown })?.error ??
		parsed;
	const message =
		typeof detail === "string"
			? detail
			: ((detail as { message?: string })?.message ??
				`The gateway rejected the request (${response.status})`);

	if (response.status === 402) {
		// Read the console wallet's own balance so the UI can show what is
		// actually short, without reaching for any end user's row.
		const wallet = await ensureStudioWallet({ ctx });
		const balance = await getFeatureBalance({
			db: ctx.db,
			customerInternalId: wallet.internal_id,
			featureId: litellmFeatureId(),
		});
		// What the turn would have cost, as the gateway's admission check
		// computed it -- input plus the output cap at this org's rates.
		// LiteLLM nests the detail under `provider_specific_fields`.
		const upstream =
			((detail as { provider_specific_fields?: Record<string, unknown> })
				?.provider_specific_fields ?? detail) as
				| Record<string, unknown>
				| undefined;
		const required = upstream?.required_credits;
		return c.json(
			{
				error: {
					type: "insufficient_balance",
					code: "insufficient_balance",
					message,
					// Named so the client can tell a console paywall from a
					// customer one: this is the merchant's wallet, not theirs.
					scope: "console",
					customer_id: wallet.id,
					balance,
					required_credits:
						typeof required === "number" ? required : undefined,
				},
			},
			402,
		);
	}

	if (response.status === 404) {
		throw new ModelNotFoundError({ model: "unknown" });
	}

	throw new GatewayError({
		message: `The gateway failed to serve the request (${response.status}): ${message}`,
		statusCode: 502,
	});
};
