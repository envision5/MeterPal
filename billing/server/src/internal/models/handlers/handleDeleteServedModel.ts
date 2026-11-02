// DELETE /v1/served_models/:model_id
//
// Drop a row from the org's price sheet.
//
// The model goes back to being priced by the provider (models.dev) or the
// feature's custom model pricing, whichever applied before.

import { and, eq } from "drizzle-orm";
import { ErrCode, RecaseError, Scopes, servedModels } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";

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

		await db
			.delete(servedModels)
			.where(
				and(
					eq(servedModels.org_id, org.id),
					eq(servedModels.env, env),
					eq(servedModels.model_id, modelId),
				),
			);

		return c.json({ deleted: true, model_id: modelId });
	},
});
