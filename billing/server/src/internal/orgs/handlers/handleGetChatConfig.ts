import { readChatConfig, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";

/**
 * The merchant's chat settings — currently whether the app streams its
 * responses.
 *
 * Read through `readChatConfig` so every caller sees the same effective value
 * the app executes, including the shipped default (streaming ON) when the org
 * has never saved anything.
 *
 * Mounted twice: under `/organization/chat-config` for the dashboard, and
 * under `/v1/chat-config` for a merchant's own app holding a secret key.
 */
export const handleGetChatConfig = createRoute({
	scopes: [Scopes.Organisation.Read],
	handler: async (c) => {
		const { org } = c.get("ctx");
		return c.json(readChatConfig(org.metadata));
	},
});
