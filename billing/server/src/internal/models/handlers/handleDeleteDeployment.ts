// DELETE /v1/served_models/:model_id/deployments/:deployment_id
//
// Remove one instance.  When it is the last one, the model's upstream name
// is cleared and the org's gateway keys are re-synced, handing routing back
// to whatever the gateway offered before (static config, or nothing).

import { ErrCode, RecaseError, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { recordConfigAudit } from "@/internal/audit/configAudit.js";
import { deleteDeployment } from "../deploymentService.js";

export const handleDeleteDeployment = createRoute({
	scopes: [Scopes.Organisation.Write],
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

		await deleteDeployment({ ctx, modelId, deploymentId });

		await recordConfigAudit({
			ctx,
			action: "deployment.delete",
			resource: modelId,
			metadata: { deployment_id: deploymentId },
		});

		return c.json({ deleted: true, deployment_id: deploymentId });
	},
});
