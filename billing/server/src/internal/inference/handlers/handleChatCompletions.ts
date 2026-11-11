// billing/server/src/internal/inference/handlers/handleChatCompletions.ts
//
// POST /v1/chat/completions
//
// The OpenAI-compatible inference endpoint a merchant's server calls.
//
//   Authorization: Bearer <MeterPal secret key | customer virtual key>
//
//   { "model": "custom/demo-gpt", "messages": [...], "user": "cus_123" }
//
// The response is the OpenAI response verbatim plus a `meterpal` block with
// what the call cost.

import { getBearerToken } from "@autumn/auth";
import { ErrCode, RecaseError } from "@autumn/shared";
import type { Context } from "hono";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import {
	litellmFeatureId,
	litellmRequiredBalance,
} from "@/internal/keys/litellmEnv.js";
import { resolveInferenceCaller } from "../inferenceAuth.js";
import {
	GatewayError,
	ModelNotFoundError,
} from "../inferenceErrors.js";
import {
	buildGatewayPayload,
	callGateway,
	getOrProvisionVirtualKey,
	resolveInferenceCustomer,
	resolveInferenceModel,
	settleMeterpalBlock,
	type InferenceRequest,
} from "../inferenceService.js";
import { createMeterpalSseStream } from "../streamingResponse.js";
import { getFeatureBalance } from "../usageSettlement.js";

export const handleChatCompletions = async (c: Context<HonoEnv>) => {
	const ctx = c.get("ctx");

	const token = getBearerToken({ headers: c.req.raw.headers });
	if (!token) {
		throw new RecaseError({
			message: "Secret key not found in Authorization header",
			code: ErrCode.NoSecretKey,
			statusCode: 401,
		});
	}

	const caller = await resolveInferenceCaller({ ctx, token });

	const body = await c.req.json<InferenceRequest>().catch(() => null);
	if (!body || typeof body.model !== "string" || body.model.length === 0) {
		throw new RecaseError({
			message: "`model` is required",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	const resolvedModel = await resolveInferenceModel({ ctx, model: body.model });
	const customer = await resolveInferenceCustomer({ ctx, caller, body });
	const virtualKey = await getOrProvisionVirtualKey({ ctx, customer });

	const callId = crypto.randomUUID();
	const payload = buildGatewayPayload({
		body,
		resolvedModel,
		customerId: customer.id,
	});

	const gatewayResponse = await callGateway({ virtualKey, callId, payload });

	if (!gatewayResponse.ok) {
		return await respondWithGatewayError({
			c,
			ctx,
			customerId: customer.id,
			customerInternalId: customer.internal_id,
			response: gatewayResponse,
		});
	}

	if (body.stream) {
		if (!gatewayResponse.body) {
			throw new GatewayError({
				message: "The gateway returned an empty stream",
				statusCode: 502,
			});
		}

		const stream = createMeterpalSseStream({
			body: gatewayResponse.body,
			settle: async () => settleMeterpalBlock({ ctx, customer, callId }),
		});

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"x-meterpal-call-id": callId,
			},
		});
	}

	const json = await gatewayResponse.json();
	const meterpal = await settleMeterpalBlock({ ctx, customer, callId });

	return c.json({ ...json, meterpal });
};

/**
 * Turn a gateway refusal into the answer the SDK expects.
 *
 * A 402 is the paywall: the end user must top up.  It is the whole point of
 * the product, so it gets a first-class shape rather than a raw gateway
 * error.
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

	const detail = (parsed as { detail?: unknown })?.detail ??
		(parsed as { error?: unknown })?.error ??
		parsed;
	const message =
		typeof detail === "string"
			? detail
			: ((detail as { message?: string })?.message ??
				`The gateway rejected the request (${response.status})`);

	if (response.status === 402) {
		// What the customer has, and what the call would have cost.
		//
		// The balance is read here because this server knows the settled
		// figure.  The REQUIREMENT cannot be read here: it is the request's
		// own estimate -- input plus the output cap priced at this org's
		// sheet -- and only the gateway's admission check computed it.  The
		// gateway forwards that number in the 402, nested by LiteLLM under
		// `provider_specific_fields`.  Reporting the policy floor instead
		// (PAB_REQUIRED_BALANCE) produced a paywall that said "balance 2.23 /
		// needed 0.50" while refusing the call: the floor is the minimum a
		// call may START with, not what this call needs.
		const upstream =
			((detail as { provider_specific_fields?: Record<string, unknown> })
				?.provider_specific_fields ?? detail) as
				| Record<string, unknown>
				| undefined;
		const requiredFromGateway = upstream?.required_credits;
		const balanceFromGateway = upstream?.balance;

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
					balance: balance ?? balanceFromGateway ?? null,
					required_credits:
						typeof requiredFromGateway === "number"
							? requiredFromGateway
							: litellmRequiredBalance(),
				},
			},
			402,
		);
	}

	if (response.status === 404) {
		throw new ModelNotFoundError({ model: "unknown" });
	}

	if (response.status === 429) {
		return c.json(
			{
				error: {
					type: "rate_limit_error",
					code: "rate_limit_exceeded",
					message,
					customer_id: customerId,
				},
			},
			429,
		);
	}

	if (response.status === 401 || response.status === 403) {
		// The gateway refused the credential we minted for this customer.
		// That is a MeterPal-side fault, not the caller's.
		throw new GatewayError({
			message: `The gateway rejected the inference key for this customer (${response.status}): ${message}`,
			statusCode: 502,
		});
	}

	throw new GatewayError({
		message: `The gateway failed to serve the request (${response.status}): ${message}`,
		statusCode: 502,
	});
};
