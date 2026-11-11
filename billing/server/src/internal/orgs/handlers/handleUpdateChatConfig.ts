import {
	ChatConfigSchema,
	organizations,
	readChatConfig,
	Scopes,
	writeChatConfig,
} from "@autumn/shared";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { clearOrgCache } from "../orgUtils/clearOrgCache.js";

/**
 * Persist the merchant's chat settings.
 *
 * Only the keys present in the request are written; the rest of the metadata
 * blob — including the agent mandates stored beside this one — is preserved.
 * `clearOrgCache` matters for the same reason it does on the agent config:
 * the app reads the effective value from the cached org row.
 */
const bodySchema = z.object({
	streaming: z.boolean().optional(),
});

export const handleUpdateChatConfig = createRoute({
	scopes: [Scopes.Organisation.Write],
	body: bodySchema,
	handler: async (c) => {
		const { db, org } = c.get("ctx");
		const body = c.req.valid("json");

		if (body.streaming === undefined) {
			return c.json(readChatConfig(org.metadata));
		}

		const nextMetadata = writeChatConfig(org.metadata, body);

		await db
			.update(organizations)
			.set({ metadata: nextMetadata })
			.where(eq(organizations.id, org.id));

		await clearOrgCache({ db, orgId: org.id });

		return c.json(ChatConfigSchema.parse(readChatConfig(nextMetadata)));
	},
});
