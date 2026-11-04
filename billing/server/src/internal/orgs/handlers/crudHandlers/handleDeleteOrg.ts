import type { Organization } from "@autumn/shared";
import { deleteSvixApp } from "@/external/svix/svixHelpers.js";
import { createRoute } from "../../../../honoMiddlewares/routeHandler.js";
import { deleteOrg } from "../../deleteOrg/deleteOrg.js";
import { Scopes } from "@autumn/shared";

const deleteSvixWebhooks = async ({
	org,
	logger,
}: {
	org: Organization;
	logger: any;
}) => {
	const batch = [];
	if (org.svix_config?.sandbox_app_id) {
		batch.push(
			deleteSvixApp({
				appId: org.svix_config.sandbox_app_id,
			}),
		);
	}

	if (org.svix_config?.live_app_id) {
		batch.push(
			deleteSvixApp({
				appId: org.svix_config.live_app_id,
			}),
		);
	}

	try {
		await Promise.all(batch);
	} catch (error) {
		logger.error(`Failed to delete svix webhooks for ${org.id}, ${org.slug}`);
	}
};

export const handleDeleteOrg = createRoute({
	scopes: [Scopes.Owner],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { org, db, logger } = ctx;

		await deleteOrg({
			org,
			db,
			logger,
			deleteOrgFromDb: false,
		});

		return c.json({
			message: "Org deleted",
		});
	},
});
