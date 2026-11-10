// billing/server/src/internal/studio/handleStudioAi.ts
//
// POST /studio/ai
//
// One metered turn of AG Studio's agent loop.
//
// AG Studio never talks to a model provider itself: the app supplies an
// `AgLlmAdapter`, and the adapter calls this route. The call goes through the
// same inference path as every other metered completion in this server --
// resolve the model, resolve the customer being billed, mint that customer's
// gateway key, forward to the gateway, and settle the charge.
//
// The point of the demo: the agent that builds the merchant's dashboard is
// itself metered. Its spend comes off the same wallet the customer's product
// draws on, and when that wallet is empty the agent is paywalled exactly like
// the end user would be.

import { Scopes } from "@autumn/shared";
import type { Context } from "hono";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import type { InferenceCaller } from "@/internal/inference/inferenceAuth.js";
import {
	GatewayError,
	ModelNotFoundError,
} from "@/internal/inference/inferenceErrors.js";
import {
	buildGatewayPayload,
	callGateway,
	getOrProvisionVirtualKey,
	resolveInferenceCustomer,
	resolveInferenceModel,
	settleMeterpalBlock,
} from "@/internal/inference/inferenceService.js";
import { litellmFeatureId } from "@/internal/keys/litellmEnv.js";
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

const StudioAiSchema = z.object({
	/** The customer whose wallet pays for this turn. */
	customer_id: z.string().min(1),
	/** The model to run. Defaults to the org's first enabled served model. */
	model: z.string().optional(),
	/** AG Studio's `AgLlmRequest`. */
	request: z.object({}).passthrough().optional(),
});

/**
 * The caller identity for a dashboard-initiated turn.
 *
 * A dashboard session is not a secret key, but it acts for the org: it may
 * bill any customer of that org, and only that org. Modelling it as the
 * secret-key caller is exactly the authority it has.
 */
const dashboardCaller = (ctx: AutumnContext): InferenceCaller => ({
	org: ctx.org,
	env: ctx.env,
	features: ctx.features,
	credential: "secret_key",
	customerId: null,
});

export const handleStudioAi = createRoute({
	scopes: [Scopes.Billing.Write],
	body: StudioAiSchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { customer_id, model, request } = c.req.valid("json");

		const studioRequest = (request ?? {}) as StudioLlmRequest;

		// Which model? An explicit one wins; otherwise the org's default.
		const modelId =
			model ??
			studioRequest.model?.id ??
			process.env.STUDIO_DEFAULT_MODEL ??
			"custom/demo-gpt";

		const resolvedModel = await resolveInferenceModel({ ctx, model: modelId });

		const customer = await resolveInferenceCustomer({
			ctx,
			caller: dashboardCaller(ctx),
			body: { model: modelId, user: customer_id },
		});

		const virtualKey = await getOrProvisionVirtualKey({ ctx, customer });

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
				...(tools ? { tools } : {}),
				...(toolChoice ? { tool_choice: toolChoice } : {}),
				...(responseFormat ? { response_format: responseFormat } : {}),
			},
			resolvedModel,
			customerId: customer.id as string,
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
				customerId: customer.id as string,
				customerInternalId: customer.internal_id,
				response: gatewayResponse,
			});
		}

		const completion = (await gatewayResponse.json()) as OpenAiChatCompletion;
		const meterpal = await settleMeterpalBlock({ ctx, customer, callId });

		const studioResponse = openAiCompletionToStudioResponse({
			completion,
			fallbackId: callId,
		});

		ctx.logger.info("AG Studio agent turn metered", {
			orgId: ctx.org.id,
			customerId: customer.id,
			model: resolvedModel.billableModelId,
			creditsCharged: meterpal.credits_charged,
			toolCalls: studioResponse.output.filter(
				(item) => item.type === "function_call",
			).length,
		});

		return c.json({
			...studioResponse,
			// What the turn cost, so the UI can show it and the demo can prove
			// the agent is metered.
			meterpal,
		});
	},
});

/**
 * Turn a gateway refusal into the answer the dashboard expects.
 *
 * A 402 is the paywall: the customer's wallet is empty, so the agent cannot
 * run. That is a first-class outcome here, not an error -- it is the product
 * working.
 */
const respondWithGatewayError = async ({
	c,
	ctx,
	customerId,
	customerInternalId,
	response,
}: {
	c: Context<HonoEnv>;
	ctx: AutumnContext;
	customerId: string;
	customerInternalId: string;
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
		const balance = await getFeatureBalance({
			db: ctx.db,
			customerInternalId,
			featureId: litellmFeatureId(),
		});
		return c.json(
			{
				error: {
					type: "insufficient_balance",
					code: "insufficient_balance",
					message,
					customer_id: customerId,
					balance,
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
