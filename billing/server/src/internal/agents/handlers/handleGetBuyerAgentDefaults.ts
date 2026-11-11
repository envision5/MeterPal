// billing/server/src/internal/agents/handlers/handleGetBuyerAgentDefaults.ts
//
// GET /v1/agent/buyer-defaults
//
// The standing terms the merchant offers a customer's own buying agent, for
// when that customer has not set a per-customer mandate.  This is what the
// merchant edits under Settings -> Agent -> "Buyer agent defaults".
//
// Deliberately returns ONLY the buyer side.  The seller ladder and the
// authorized coupons are the merchant's negotiation strategy and must never
// be readable with a customer-facing key.

import { readAgentConfig, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";

export const handleGetBuyerAgentDefaults = createRoute({
	scopes: [Scopes.Customers.Read],
	handler: async (c) => {
		const { org } = c.get("ctx");
		return c.json(readAgentConfig(org.metadata).buyer_agent_defaults);
	},
});
