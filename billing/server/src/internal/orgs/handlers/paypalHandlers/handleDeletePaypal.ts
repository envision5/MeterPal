// billing/server/src/internal/orgs/handlers/paypalHandlers/handleDeletePaypal.ts
//
// DELETE /v1/organization/paypal
//
// Disconnects the org's own PayPal account for the current environment.
//
// Only the connection for THIS environment is removed, so a merchant can
// disconnect their sandbox app while their live app keeps working.  The
// platform's shared account (the PAYPAL_* environment variables) is not
// affected — it is not the org's to remove.

import { Scopes } from "@autumn/shared";
import { recordConfigAudit } from "@/internal/audit/configAudit.js";
import { getMiscRedis } from "@/external/redis/miscCache/getMiscRedis.js";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { OrgService } from "../../OrgService.js";
import {
	billingEnvForPaypalEnv,
	paypalEnvForBillingEnv,
} from "./paypalConfigUtils.js";

export const handleDeletePaypal = createRoute({
	scopes: [Scopes.Organisation.Write],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { db, org, env, logger } = ctx;

		const paypalEnv = paypalEnvForBillingEnv(env);
		const existing = org.paypal_config;
		if (!existing) {
			return c.json({ connected: false });
		}

		const remaining: Record<string, unknown> = { ...existing };
		if (paypalEnv === "live") {
			delete remaining.live;
		} else {
			delete remaining.test;
		}

		const stillOwnsPaypal = !!(remaining.test || remaining.live);

		await OrgService.update({
			db,
			orgId: org.id,
			updates: {
				paypal_config: stillOwnsPaypal ? remaining : null,
				paypal_connected: stillOwnsPaypal,
			},
		});

		// The cached token belongs to the credentials that were just removed.
		await getMiscRedis()
			.del(`${org.id}:${billingEnvForPaypalEnv(paypalEnv)}:paypal_token:${paypalEnv}`)
			.catch(() => {});

		await recordConfigAudit({
			ctx,
			action: "paypal.disconnect",
			resource: org.id,
			metadata: { paypal_env: paypalEnv },
		});

		logger.info("paypal disconnected for org", {
			orgId: org.id,
			env,
			paypalEnv,
		});

		return c.json({ connected: false, env: paypalEnv });
	},
});
