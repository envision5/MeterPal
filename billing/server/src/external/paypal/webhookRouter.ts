// billing/server/src/external/paypal/webhookRouter.ts
//
// Mounts the PayPal webhook endpoint on a Hono router.  Verifies the
// signature using verifyPaypalSignature() then dispatches to the event
// handlers in runPaypalWebhookHandlers.ts.
//
// Critical: this route reads the raw body BEFORE any JSON.parse.  PayPal
// explicitly requires byte-identical input for CRC32 computation:
// https://developer.paypal.com/api/rest/webhooks/rest
//
// Routes:
//   POST /webhooks/paypal/{org_id}            — the URL auto-registration
//     creates (ensurePaypalWebhook); the environment is resolved by trying
//     each of the org's stored webhook ids against the signature.
//   POST /webhooks/paypal/{org_id}/{webhook_id} — the merchant-pasted form;
//     the id in the URL names the org's PayPal connection.
//   POST /webhooks/paypal                     — single-tenant setup, where
//     one process-wide webhook id serves everybody.
//
// The org is resolved from the path BEFORE any state is read, and the
// signature is verified against THAT org's webhook id.

import { AppEnv, type Organization } from "@autumn/shared";
import { type Context, Hono } from "hono";
import { db } from "@/db/initDrizzle.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { OrgService } from "@/internal/orgs/OrgService.js";
import {
	getPaypalClient,
	type PaypalClient,
	paypalEnvForOrg,
	paypalEnvForWebhookId,
} from "./paypalClient.js";
import { handlePaypalEvent } from "./runPaypalWebhookHandlers.js";
import { verifyPaypalSignature } from "./webhookSecurity.js";

export const paypalWebhookRouter = new Hono<HonoEnv>();

type PayPalEventBody = { id: string; event_type: string; resource: unknown };

/**
 * Shared tail of every PayPal webhook route: verify against `webhookId`,
 * then dispatch (a 5xx triggers PayPal's 25-retry policy).  Returns the
 * Hono text response.
 */
async function verifyAndDispatchPaypalEvent({
	c,
	org,
	webhookId,
	env,
	raw,
}: {
	c: Context<HonoEnv>;
	org: Organization;
	webhookId: string;
	env: AppEnv;
	raw: Buffer;
}): Promise<Response> {
	// Use Hono's cached body accessor, not c.req.raw: baseMiddleware runs
	// c.req.json() ahead of this route, which consumes the raw stream (reading
	// c.req.raw here throws "Body already used"). Hono's arrayBuffer() replays
	// the cached bytes, still byte-identical for CRC32.
	const ok = await verifyPaypalSignature(raw, c.req.raw.headers, {
		webhookId,
	});
	if (!ok) {
		// Log before refusing: signature failures are the one event that
		// should never be silent (spec §5).
		logger.warn("paypal webhook refused: invalid signature", {
			orgId: org.id,
			webhookId,
			transmission_id: c.req.header("paypal-transmission-id"),
		});
		return c.text("invalid signature", 401);
	}

	let event: PayPalEventBody;
	try {
		event = JSON.parse(raw.toString("utf-8")) as PayPalEventBody;
	} catch {
		return c.text("invalid json", 400);
	}

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
			// Scope the payer/email customer fallbacks to THIS org: the
			// webhook URL named it, so a grant can never land on another
			// org's customer.
			org.id,
		);
	} catch (e) {
		// Returning 5xx triggers PayPal's 25-retry-over-3-days policy.
		// Log and return 500 so a transient failure gets retried.
		console.error(
			`paypal webhook ${event.id} ${event.event_type} failed (org ${org.id})`,
			e,
		);
		return c.text("handler error", 500);
	}

	return c.text("ok", 200);
}

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
		// Forensic signal: an unregistered webhook id is most likely a
		// misconfiguration, but it is also what an attack looks like.
		logger.warn("paypal webhook refused: webhook id mismatch", {
			orgId: org.id,
			webhookId,
		});
		return c.text("webhook id mismatch", 401);
	} else {
		env =
			paypalEnvForOrg({ org, env: AppEnv.Sandbox }) === "live"
				? AppEnv.Live
				: AppEnv.Sandbox;
	}

	const raw = Buffer.from(await c.req.arrayBuffer());
	return verifyAndDispatchPaypalEvent({ c, org, webhookId, env, raw });
});

/**
 * Id-less per-org route: POST /webhooks/paypal/{org_id}
 *
 * This is the URL auto-registration creates (see ensurePaypalWebhook) —
 * the webhook id only exists AFTER PayPal creates the webhook, so the URL
 * cannot embed it up front.  Signature verification instead tries each of
 * the org's stored webhook ids (test / live); the id whose verification
 * passes both authenticates the event AND names its environment.
 * Merchants who registered a webhook by hand can point PayPal here too.
 */
paypalWebhookRouter.post("/webhooks/paypal/:orgId", async (c) => {
	const orgId = c.req.param("orgId");
	let org;
	try {
		org = await OrgService.get({ db, orgId });
	} catch {
		return c.text("unknown org", 404);
	}

	const raw = Buffer.from(await c.req.arrayBuffer());

	const candidates: Array<{ webhookId: string; env: AppEnv }> = [
		...(org.paypal_config?.test?.webhook_id
			? [{ webhookId: org.paypal_config.test.webhook_id, env: AppEnv.Sandbox }]
			: []),
		...(org.paypal_config?.live?.webhook_id
			? [{ webhookId: org.paypal_config.live.webhook_id, env: AppEnv.Live }]
			: []),
	];

	for (const candidate of candidates) {
		const ok = await verifyPaypalSignature(raw, c.req.raw.headers, {
			webhookId: candidate.webhookId,
		});
		if (!ok) continue;
		return verifyAndDispatchPaypalEvent({
			c,
			org,
			webhookId: candidate.webhookId,
			env: candidate.env,
			raw,
		});
	}

	// An org with no stored config falls back to the process-wide account
	// (the single-tenant setup) — same behavior as the legacy route.
	if (!candidates.length) {
		const env =
			paypalEnvForOrg({ org, env: AppEnv.Sandbox }) === "live"
				? AppEnv.Live
				: AppEnv.Sandbox;
		const webhookId = process.env.PAYPAL_WEBHOOK_ID ?? "";
		if (webhookId) {
			return verifyAndDispatchPaypalEvent({
				c,
				org,
				webhookId,
				env,
				raw,
			});
		}
	}

	logger.warn("paypal webhook refused: no webhook id verified", {
		orgId: org.id,
		transmission_id: c.req.header("paypal-transmission-id"),
	});
	return c.text("invalid signature", 401);
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
