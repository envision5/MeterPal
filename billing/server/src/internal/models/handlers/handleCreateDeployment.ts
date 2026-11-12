// POST /v1/served_models/:model_id/deployments
//
// Add one instance of a served model, wired to a real provider account.
//
// The key is stored encrypted and pushed to the gateway in the same request,
// so a deployment the dashboard shows is one the gateway can route to. The
// key and the extra-params blob are never returned: responses carry only the
// key's last four characters and the extra params' key names.

import { and, eq } from "drizzle-orm";
import {
	ErrCode,
	RecaseError,
	Scopes,
	servedModels,
} from "@autumn/shared";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { recordConfigAudit } from "@/internal/audit/configAudit.js";
import { createDeployment, toDeploymentResponse } from "../deploymentService.js";

export const handleCreateDeployment = createRoute({
	scopes: [Scopes.Organisation.Write],
	body: z.object({
		provider_model: z
			.string()
			.min(1, "A provider model is required")
			.regex(/.+\/.+/, "Use a provider-prefixed model, e.g. openai/gpt-4o-mini"),
		api_key: z.string().min(1, "An API key is required"),
		api_base: z.string().url("The API base must be a URL").nullish(),
		rpm: z.number().int().positive().nullish(),
		tpm: z.number().int().positive().nullish(),
		timeout: z.number().positive().nullish(),
		max_retries: z.number().int().nonnegative().nullish(),
		weight: z.number().int().positive().nullish(),
		/** LiteLLM's `order` — lower orders are tried first. */
		order: z.number().int().nonnegative().nullish(),
		organization: z.string().min(1).nullish(),
		extra_params: z.record(z.string(), z.unknown()).nullish(),
		/** Input modalities. Absent = not configured, [] = text only. */
		modalities: z.array(z.string()).nullish(),
	}),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { org, env } = ctx;
		const modelId = c.req.param("model_id");
		if (!modelId) {
			throw new RecaseError({
				message: "A model id is required",
				code: ErrCode.InvalidRequest,
				statusCode: 400,
			});
		}
		const body = c.req.valid("json");

		const served = await ctx.db.query.servedModels.findFirst({
			where: and(
				eq(servedModels.org_id, org.id),
				eq(servedModels.env, env),
				eq(servedModels.model_id, modelId),
			),
		});
		if (!served) {
			throw new RecaseError({
				message: `Model ${modelId} is not on your price sheet. Add it first, then configure its instances.`,
				code: ErrCode.InvalidRequest,
				statusCode: 404,
			});
		}

		const deployment = await createDeployment({
			ctx,
			modelId,
			input: { ...body, routing_order: body.order ?? null },
		});

		await recordConfigAudit({
			ctx,
			action: "deployment.create",
			resource: modelId,
			metadata: {
				deployment_id: deployment.internal_id,
				provider_model: deployment.provider_model,
				api_base: deployment.api_base,
				api_key_hint: deployment.api_key_hint,
				rpm: deployment.rpm,
				tpm: deployment.tpm,
				timeout: deployment.timeout,
				max_retries: deployment.max_retries,
				weight: deployment.weight,
				order: deployment.routing_order,
				organization: deployment.organization,
				modalities: deployment.modalities,
				extra_params_keys: deployment.extra_params_keys,
			},
		});

		return c.json({ deployment: toDeploymentResponse(deployment) });
	},
});
