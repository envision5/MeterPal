import { readAgentConfig, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";

/**
 * The merchant's agent configuration: the sales agent's pricing mandate and
 * the buyer agent's default terms.
 *
 * Reads through `readAgentConfig` so the settings page always sees the same
 * effective values the agents execute — including the shipped defaults when
 * the org has never saved anything.
 */
export const handleGetAgentConfig = createRoute({
	scopes: [Scopes.Organisation.Read],
	handler: async (c) => {
		const { org } = c.get("ctx");
		return c.json(readAgentConfig(org.metadata));
	},
});
