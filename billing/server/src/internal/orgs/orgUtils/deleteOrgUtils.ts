import type { Organization } from "@autumn/shared";
import type { Logger } from "@/external/logtail/logtailUtils.js";
import { deleteSvixApp } from "@/external/svix/svixHelpers.js";

export const deleteSvixWebhooks = async ({
	org,
	logger,
}: {
	org: Organization;
	logger: Logger;
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
