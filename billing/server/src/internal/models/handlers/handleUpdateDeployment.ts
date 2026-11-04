// PATCH /v1/served_models/:model_id/deployments/:deployment_id
//
// Edit one instance of a served model.  A re-pointed or re-keyed deployment
// is deleted from the gateway and re-created under the same model name, so
// the group keeps routing while the instance changes under it.
//
// Absent fields keep their stored value; `extra_params` follows the same
// rule, with an explicit empty object meaning "clear all advanced params".

import { ErrCode, RecaseError, Scopes } from "@autumn/shared";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { recordConfigAudit } from "@/internal/audit/configAudit.js";
import { toDeploymentResponse, updateDeployment } from "../deploymentService.js";

export const handleUpdateDeployment = createRoute({
	scopes: [Scopes.Organisation.Write],
	body: z.object({
		provider_model: z
			.string()
			.regex(/.+\/.+/, "Use a provider-prefixed model, e.g. openai/gpt-4o-mini")
			.optional(),
		/** Empty or absent keeps the stored key. */
		api_key: z.string().optional(),
		api_base: z.string().url("The API base must be a URL").nullish(),
		rpm: z.number().int().positive().nullish(),
		tpm: z.number().int().positive().nullish(),
		timeout: z.number().positive().nullish(),
		max_retries: z.number().int().nonnegative().nullish(),
		weight: z.number().int().positive().nullish(),
		order: z.number().int().nonnegative().nullish(),
		organization: z.string().min(1).nullish(),
		/** Absent keeps the stored blob; {} clears it. */
		extra_params: z.record(z.string(), z.unknown()).optional(),
	}),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const modelId = c.req.param("model_id");
		const deploymentId = c.req.param("deployment_id");
		if (!modelId || !deploymentId) {
			throw new RecaseError({
				message: "A model id and deployment id are required",
				code: ErrCode.InvalidRequest,
				statusCode: 400,
			});
		}
		const body = c.req.valid("json");

		const deployment = await updateDeployment({
			ctx,
			modelId,
			deploymentId,
			input: { ...body, routing_order: body.order },
		});

		await recordConfigAudit({
			ctx,
			action: "deployment.update",
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
				extra_params_keys: deployment.extra_params_keys,
				key_rotated: Boolean(body.api_key && body.api_key.length > 0),
			},
		});

		return c.json({ deployment: toDeploymentResponse(deployment) });
	},
});
