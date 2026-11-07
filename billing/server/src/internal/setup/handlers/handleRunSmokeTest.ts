// billing/server/src/internal/setup/handlers/handleRunSmokeTest.ts
//
// POST /v1/organization/setup/smoke-test
//
// The wizard's last step: one real, metered, billed inference call.
//
// It is not a simulation.  The call goes through the same path a merchant's
// app takes -- the org's price sheet decides the model, the gateway serves
// it, the bridge meters it and settles it against the end user's balance.
// The credits the merchant sees are the credits their customer was charged.
//
// The end user is a dedicated one in the merchant's own org ("Setup test"),
// so the charge shows up in their own usage and their own balance, and
// their real customers are never billed by a test.

import { ErrCode, RecaseError, Scopes } from "@autumn/shared";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import {
	buildGatewayPayload,
	callGateway,
	findInferenceCustomer,
	getOrProvisionVirtualKey,
	resolveInferenceModel,
	settleMeterpalBlock,
} from "@/internal/inference/inferenceService.js";
import { listServedModels } from "@/internal/models/servedModelService.js";
import {
	ensureSetupCustomer,
	ensureSetupCustomerBalance,
	SETUP_CUSTOMER_ID,
} from "../setupUtils.js";

const bodySchema = z.object({
	/** The model to call. Defaults to the first model on the price sheet. */
	model: z.string().min(1).optional(),
});

/** What the test asks for. Short, so it costs a rounding error. */
const SMOKE_TEST_PROMPT = "Say hello in one short sentence.";

export const handleRunSmokeTest = createRoute({
	scopes: [Scopes.Organisation.Write],
	body: bodySchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { db, org, env } = ctx;
		const { model: requestedModel } = c.req.valid("json");

		const modelId = requestedModel ?? (await pickDefaultModel({ ctx }));
		if (!modelId) {
			throw new RecaseError({
				message:
					"No models on your price sheet yet. Add one in the Models tab, then run the test.",
				code: ErrCode.InvalidRequest,
				statusCode: 400,
			});
		}

		// The end user being charged.  Created on first use, through the normal
		// customer path, so the org's auto-enabled plans attach to it.
		await ensureSetupCustomer({ ctx });

		const customer = await findInferenceCustomer({
			db,
			orgId: org.id,
			env,
			idOrInternalId: SETUP_CUSTOMER_ID,
		});

		if (!customer) {
			throw new RecaseError({
				message: "Could not create the test end user for this organization.",
				code: ErrCode.InvalidRequest,
				statusCode: 500,
			});
		}

		// The test must always be runnable: earlier runs may have drained the
		// test user's credits, so restore them before the call.
		await ensureSetupCustomerBalance({
			ctx,
			customerId: customer.id,
			customerInternalId: customer.internal_id,
		});

		// The same resolution the public endpoint does: the org's price sheet
		// decides which model this is and what it bills as.
		const resolvedModel = await resolveInferenceModel({ ctx, model: modelId });
		const virtualKey = await getOrProvisionVirtualKey({ ctx, customer });

		const callId = crypto.randomUUID();
		const payload = buildGatewayPayload({
			body: {
				model: modelId,
				messages: [{ role: "user", content: SMOKE_TEST_PROMPT }],
				max_tokens: 32,
			},
			resolvedModel,
			customerId: customer.id,
		});

		const gatewayResponse = await callGateway({ virtualKey, callId, payload });

		if (!gatewayResponse.ok) {
			throw new RecaseError({
				message: await gatewayRejectionMessage(gatewayResponse),
				code: ErrCode.ProcessorError,
				statusCode: 502,
			});
		}

		const json = (await gatewayResponse.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const reply = json.choices?.[0]?.message?.content ?? null;

		const meterpal = await settleMeterpalBlock({ ctx, customer, callId });

		return c.json({
			customer_id: customer.id,
			model_id: resolvedModel.billableModelId,
			upstream_model: resolvedModel.upstreamModel,
			reply,
			meterpal,
		});
	},
});

/**
 * The first model on the org's price sheet the gateway can actually serve.
 *
 * A sheet model is only callable once it has an upstream mapping (an
 * instance/deployment behind it); one added without that would send its own
 * id to the gateway and be rejected as an unknown model.  Those are skipped
 * so the test exercises a model that can really answer.
 */
async function pickDefaultModel({
	ctx,
}: {
	ctx: AutumnContext;
}): Promise<string | null> {
	const models = await listServedModels({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
	});
	const enabled = models.filter((m) => m.enabled);
	return (
		enabled.find((m) => m.upstream_model)?.model_id ??
		enabled[0]?.model_id ??
		models[0]?.model_id ??
		null
	);
}

/**
 * A one-line, actionable reason the gateway refused the test call.
 *
 * The gateway's 402 body ("insufficient_balance" for the test end user) is
 * the one merchants will actually hit -- name it and the fix, rather than
 * echoing the raw LiteLLM error object.
 */
async function gatewayRejectionMessage(
	response: Response,
): Promise<string> {
	const detail = await response.text().catch(() => "");
	try {
		const parsed = JSON.parse(detail) as {
			error?: { message?: string; code?: string };
		};
		const code = parsed.error?.code ?? String(response.status);
		if (code === "402" || parsed.error?.message === "insufficient_balance") {
			return "The test end user is out of credits, so the gateway declined the test call (insufficient balance). Run the test again -- the wizard restores the test user's balance automatically.";
		}
		if (parsed.error?.message) {
			return `The gateway rejected the test call: ${parsed.error.message}`;
		}
	} catch {
		// Not JSON -- fall through to the generic message.
	}
	return `The gateway rejected the test call (status ${response.status}).`;
}
