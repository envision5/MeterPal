// billing/server/src/internal/orgs/handlers/paypalHandlers/handleConnectPaypal.ts
//
// POST /v1/organization/paypal
//
// Connects the org's own PayPal account.
//
// The credentials are verified against PayPal BEFORE they are stored: an org
// that saved a broken client id would fail at checkout time, long after the
// merchant believed they were set up.
//
// The PayPal environment follows the billing environment (sandbox <-> sandbox,
// live <-> live).  A sandbox dashboard therefore connects a sandbox REST app,
// so a test checkout can never create a live PayPal subscription.

import { AppEnv, RecaseError, Scopes } from "@autumn/shared";
import { z } from "zod/v4";
import { getMiscRedis } from "@/external/redis/miscCache/getMiscRedis.js";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { encryptData } from "@/utils/encryptUtils.js";
import { OrgService } from "../../OrgService.js";
import {
	billingEnvForPaypalEnv,
	paypalEnvForBillingEnv,
	verifyPaypalCredentials,
} from "./paypalConfigUtils.js";

export const handleConnectPaypal = createRoute({
	scopes: [Scopes.Organisation.Write],
	body: z.object({
		client_id: z.string().min(3, "PayPal client id is required"),
		client_secret: z.string().min(3, "PayPal client secret is required"),
		/** The webhook id the merchant registered in their PayPal app. */
		webhook_id: z.string().min(1).optional(),
	}),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { db, org, logger, env } = ctx;
		const body = c.req.valid("json");

		const paypalEnv = paypalEnvForBillingEnv(env);
		const billingEnv = billingEnvForPaypalEnv(paypalEnv);

		let accountEmail: string | null = null;
		try {
			const verified = await verifyPaypalCredentials({
				clientId: body.client_id,
				clientSecret: body.client_secret,
				paypalEnv,
			});
			accountEmail = verified.accountEmail;
		} catch (error) {
			logger.error("paypal connect: credential verification failed", { error });
			throw new RecaseError({
				message:
					error instanceof Error
						? error.message
						: "PayPal rejected these credentials",
				statusCode: 400,
			});
		}

		const existing = org.paypal_config ?? {};
		const envConfig = {
			client_id: body.client_id,
			client_secret_enc: encryptData(body.client_secret),
			webhook_id: body.webhook_id ?? null,
			account_email: accountEmail,
			connected_at: Date.now(),
		};

		// The other environment's connection is untouched, so a merchant can
		// keep a sandbox app connected while they set up the live one.
		const paypalConfig = {
			...(existing.test ? { test: existing.test } : {}),
			...(existing.live ? { live: existing.live } : {}),
			...(paypalEnv === "live" ? { live: envConfig } : { test: envConfig }),
		};

		await OrgService.update({
			db,
			orgId: org.id,
			updates: {
				paypal_config: paypalConfig,
				paypal_connected: true,
			},
		});

		// The cached access token belongs to the OLD client id.  Leaving it in
		// place would keep the org on the previous account until the TTL ran
		// out, which is exactly the cross-tenant leak this endpoint exists to
		// prevent.
		await getMiscRedis()
			.del(`${org.id}:${billingEnv}:paypal_token:${paypalEnv}`)
			.catch(() => {});

		logger.info("paypal connected for org", {
			orgId: org.id,
			env: billingEnv,
			accountEmail,
		});

		return c.json({
			connected: true,
			env: paypalEnv,
			account_email: accountEmail,
			webhook_id: body.webhook_id ?? null,
		});
	},
});
