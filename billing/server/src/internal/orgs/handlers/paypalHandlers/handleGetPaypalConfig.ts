// billing/server/src/internal/orgs/handlers/paypalHandlers/handleGetPaypalConfig.ts
//
// GET /v1/organization/paypal
//
// The dashboard's view of the org's PayPal connection.  Reports both
// environments, so a merchant can see at a glance that they are connected in
// sandbox but not in live.
//
// The client secret is never returned.  The client id is masked.

import { Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { OrgService } from "../../OrgService.js";
import {
	billingEnvForPaypalEnv,
	paypalEnvStatus,
	type PaypalEnvStatus,
} from "./paypalConfigUtils.js";
import { paypalOrgWebhookUrl } from "./paypalConfigUtils.js";

export const handleGetPaypalConfig = createRoute({
	scopes: [Scopes.Organisation.Read],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { org, env } = ctx;

		// Read straight from the row, not from the request-scoped org: the
		// connection may have been made in the other environment, and the
		// cached org can lag a write by a moment.
		const fresh = await OrgService.get({ db: ctx.db, orgId: org.id });
		const source = fresh ?? org;

		const sandbox: PaypalEnvStatus = paypalEnvStatus({
			org: source,
			env: billingEnvForPaypalEnv("sandbox"),
		});
		const live: PaypalEnvStatus = paypalEnvStatus({
			org: source,
			env: billingEnvForPaypalEnv("live"),
		});

		return c.json({
			env,
			sandbox,
			live,
			webhook_url_template: paypalOrgWebhookUrl(org.id),
		});
	},
});
