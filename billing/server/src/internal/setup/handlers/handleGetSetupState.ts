// billing/server/src/internal/setup/handlers/handleGetSetupState.ts
//
// GET /v1/organization/setup
//
// The onboarding wizard's state.
//
// Every field is read from the tables the product runs on, so the wizard
// shows what is TRUE rather than what the wizard believes it did.  A step
// that claims to be done must be done.

import { Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { paypalEnvStatus } from "@/internal/orgs/handlers/paypalHandlers/paypalConfigUtils.js";
import { listServedModels } from "@/internal/models/servedModelService.js";
import {
	getLastSetupSmokeTest,
	listSetupPlans,
	paypalEnvForEnv,
} from "../setupUtils.js";

export const handleGetSetupState = createRoute({
	scopes: [Scopes.Organisation.Read],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { db, org, env } = ctx;

		const paypal = paypalEnvStatus({ org, env });
		const plans = await listSetupPlans({ ctx });
		const models = await listServedModels({ db, orgId: org.id, env });
		const smokeTest = await getLastSetupSmokeTest({ ctx });

		// The base URL the merchant's app calls.  The SDK's default, so the
		// snippet the wizard shows is the one that actually works.
		const apiUrl = (
			process.env.AUTUMN_PUBLIC_API_URL ??
			process.env.BETTER_AUTH_URL ??
			"http://localhost:8080"
		).replace(/\/+$/, "");

		return c.json({
			env,
			paypal: {
				...paypal,
				paypal_env: paypalEnvForEnv(env),
			},
			plans,
			models: models.map((m) => ({
				model_id: m.model_id,
				display_name: m.display_name,
				upstream_model: m.upstream_model,
				enabled: m.enabled,
				input_cost_usd_1m: m.input_cost_usd_1m,
				output_cost_usd_1m: m.output_cost_usd_1m,
				markup_pct: m.markup_pct,
			})),
			install: {
				api_url: apiUrl,
				// The secret key itself is only ever shown once, when it is
				// created -- so the wizard points at the key list rather than
				// pretending it can print a key it does not hold.
				keys_url: "/dev?tab=api_keys",
			},
			smoke_test: smokeTest,
		});
	},
});
