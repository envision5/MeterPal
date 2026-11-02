// autumn/server/src/external/paypal/webhookRouter.ts
//
// Mounts the PayPal webhook endpoint on a Hono router.  Verifies the
// signature using verifyPaypalSignature() then dispatches to the event
// handlers in runPaypalWebhookHandlers.ts.
//
// Critical: this route reads the raw body BEFORE any JSON.parse.  PayPal
// explicitly requires byte-identical input for CRC32 computation:
// https://developer.paypal.com/api/rest/webhooks/rest
//
// Each merchant registers their OWN webhook, so the URL carries the org:
//   POST /webhooks/paypal/{org_id}/{webhook_id}
// The org is resolved from the path BEFORE any state is read, and the
// signature is verified against THAT org's webhook id.  The legacy
// /webhooks/paypal route stays for the single-tenant setup, where one
// process-wide webhook id serves everybody.

import { Hono } from "hono";
import { AppEnv } from "@autumn/shared";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { db } from "@/db/initDrizzle.js";
import { verifyPaypalSignature } from "./webhookSecurity.js";
import { handlePaypalEvent } from "./runPaypalWebhookHandlers.js";
import {
	getPaypalClient,
	paypalEnvForOrg,
	paypalEnvForWebhookId,
	type PaypalClient,
} from "./paypalClient.js";
import { OrgService } from "@/internal/orgs/OrgService.js";

export const paypalWebhookRouter = new Hono<HonoEnv>();

type PayPalEventBody = { id: string; event_type: string; resource: unknown };

paypalWebhookRouter.post("/webhooks/paypal/:orgId/:webhookId", async (c) => {
	const orgId = c.req.param("orgId");
	const webhookId = c.req.param("webhookId");

	// The org comes from the URL, so the signature is checked against the
	// webhook id THIS org registered — not against a process-wide one.
	let org;
	try {
		org = await OrgService.get({ db, orgId });
	} catch {
		return c.text("unknown org", 404);
	}

	// The webhook id says which of the org's PayPal connections the event
	// belongs to: an org has one webhook per environment.  An org with no
	// stored config falls back to the process-wide account, which is the
	// single-tenant setup.
	let env: AppEnv;
	const configEnv = paypalEnvForWebhookId({ org, webhookId });
	if (configEnv) {
		env = configEnv;
	} else if (org.paypal_config?.test || org.paypal_config?.live) {
		// The org manages its own PayPal, but this webhook is not one of
		// its registered ids — refuse rather than guess an environment.
		return c.text("webhook id mismatch", 401);
	} else {
		env =
			paypalEnvForOrg({ org, env: AppEnv.Sandbox }) === "live"
				? AppEnv.Live
				: AppEnv.Sandbox;
	}

	const raw = Buffer.from(await c.req.arrayBuffer());
	// Use Hono's cached body accessor, not c.req.raw: baseMiddleware runs
	// c.req.json() ahead of this route, which consumes the raw stream (reading
	// c.req.raw here throws "Body already used"). Hono's arrayBuffer() replays
	// the cached bytes, still byte-identical for CRC32.
	const ok = await verifyPaypalSignature(raw, c.req.raw.headers, {
		webhookId,
	});
	if (!ok) return c.text("invalid signature", 401);

	const event = (() => {
		try {
			return JSON.parse(raw.toString("utf-8")) as PayPalEventBody;
		} catch {
			return null;
		}
	})();
	if (!event) return c.text("invalid json", 400);

	let client: PaypalClient | null = null;
	try {
		client = await getPaypalClient({ org, env });
	} catch {
		client = null;
	}
	if (!client) {
		// The event belongs to an org with no PayPal connection: nothing can
		// be settled against it.
		return c.text("paypal not connected for org", 409);
	}

	try {
		await handlePaypalEvent(
			{
				id: event.id,
				type: event.event_type,
				resource: event.resource,
			},
			client,
		);
	} catch (e) {
		// Returning 5xx triggers PayPal's 25-retry-over-3-days policy.
		// Log and return 500 so a transient failure gets retried.
		console.error(
			`paypal webhook ${event.id} ${event.event_type} failed (org ${orgId})`,
			e,
		);
		return c.text("handler error", 500);
	}

	return c.text("ok", 200);
});

// Legacy single-tenant route: one process-wide webhook id.
paypalWebhookRouter.post("/webhooks/paypal", async (c) => {
	const raw = Buffer.from(await c.req.arrayBuffer());

	const ok = await verifyPaypalSignature(raw, c.req.raw.headers);
	if (!ok) return c.text("invalid signature", 401);

	let event: PayPalEventBody;
	try {
		event = JSON.parse(raw.toString("utf-8")) as PayPalEventBody;
	} catch {
		return c.text("invalid json", 400);
	}

	try {
		await handlePaypalEvent({
			id: event.id,
			type: event.event_type,
			resource: event.resource,
		});
	} catch (e) {
		// Returning 5xx triggers PayPal's 25-retry-over-3-days policy.
		// Log and return 500 so a transient failure gets retried.
		console.error(`paypal webhook ${event.id} ${event.event_type} failed`, e);
		return c.text("handler error", 500);
	}

	return c.text("ok", 200);
});
