// DELETE /v1/served_models/:model_id
//
// Drop a row from the org's price sheet.
//
// The model goes back to being priced by the provider (models.dev) or the
// feature's custom model pricing, whichever applied before.

import { and, eq } from "drizzle-orm";
import { ErrCode, RecaseError, Scopes, servedModels } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { syncOrgLitellmKeys } from "@/internal/keys/litellmKeys.js";
import { recordConfigAudit } from "@/internal/audit/configAudit.js";
import {
	listDeployments,
	removeDeploymentFromGateway,
} from "../deploymentService.js";

export const handleDeleteServedModel = createRoute({
	scopes: [Scopes.Organisation.Write],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { db, org, env } = ctx;
		const modelId = c.req.param("model_id");
		if (!modelId) {
			throw new RecaseError({
				message: "A model id is required",
				code: ErrCode.InvalidRequest,
				statusCode: 400,
			});
		}

		// The DB cascade would silently drop the deployment rows, but the
		// gateway would keep serving through those keys -- remove them there
		// first, and let a gateway failure stop the delete (retrying is safe:
		// "already gone" counts as removed).
		const deployments = await listDeployments({ ctx, orgId: org.id, env, modelId });
		for (const deployment of deployments) {
			if (deployment.gateway_model_id) {
				await removeDeploymentFromGateway({
					gatewayModelId: deployment.gateway_model_id,
				});
			}
		}

		await db
			.delete(servedModels)
			.where(
				and(
					eq(servedModels.org_id, org.id),
					eq(servedModels.env, env),
					eq(servedModels.model_id, modelId),
				),
			);

		await recordConfigAudit({
			ctx,
			action: "served_model.delete",
			resource: modelId,
		});

		// The gateway enforces the model allow-list on the key, so dropping a
		// row has to reach it too.
		const sync = await syncOrgLitellmKeys(ctx, org.id);

		return c.json({
			deleted: true,
			model_id: modelId,
			keys_synced: sync.synced,
			keys_failed: sync.failed,
		});
	},
});
