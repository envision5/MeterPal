// billing/server/src/internal/orgs/handlers/paypalHandlers/paypalConfigUtils.ts
//
// Shared helpers for the PayPal connection endpoints.
//
// The dashboard shows two very different states and they must not be confused:
//
//   1. The org manages its own PayPal account — `paypal_config` holds that
//      org's client id / secret / webhook id.  The merchant receives the
//      money directly.
//   2. The org has no connection of its own — the process-wide PAYPAL_*
//      variables answer, so billing runs through the platform's shared
//      sandbox account.  That is the single-tenant setup, and the dashboard
//      says so plainly instead of pretending the org is connected.

import { AppEnv, type Organization } from "@autumn/shared";
import {
	type PaypalClient,
	paypalBaseUrl,
} from "@/external/paypal/paypalClient.js";
import {
	createWebhook,
	listWebhooks,
} from "@/external/paypal/subscriptions.js";
import { PAYPAL_WEBHOOK_EVENT_TYPES } from "@/external/paypal/webhookEventTypes.js";

export type PaypalEnv = "sandbox" | "live";

/** The billing env ↔ PayPal env mapping. They are 1:1. */
export function billingEnvForPaypalEnv(env: PaypalEnv): AppEnv {
	return env === "live" ? AppEnv.Live : AppEnv.Sandbox;
}

export function paypalEnvForBillingEnv(env: AppEnv): PaypalEnv {
	return env === AppEnv.Live ? "live" : "sandbox";
}

/**
 * What the dashboard renders for one environment.
 *
 * Never carries the client secret, and masks the client id so a screenshot
 * of the settings page does not leak a usable credential.
 */
export interface PaypalEnvStatus {
	/** True when this org can bill through PayPal in this env. */
	connected: boolean;
	/** True when the connection comes from the platform's shared account. */
	shared_account: boolean;
	/** Masked client id, e.g. "A1b2…9xyz". */
	client_id: string | null;
	/** The PayPal account the connection acts on behalf of. */
	account_email: string | null;
	/** The webhook id the org registered with PayPal. */
	webhook_id: string | null;
	/** Epoch ms when the org connected. */
	connected_at: number | null;
}

/** Mask a credential so it can be shown but not reused. */
export function maskClientId(clientId: string): string {
	if (clientId.length <= 10) return `${clientId.slice(0, 2)}…`;
	return `${clientId.slice(0, 5)}…${clientId.slice(-4)}`;
}

/**
 * The org's status for one environment.
 *
 * An org with its own config answers from that config; an org without one
 * falls back to the process-wide credentials, which is reported as a shared
 * account rather than as "connected".
 */
export function paypalEnvStatus({
	org,
	env,
}: {
	org: Organization;
	env: AppEnv;
}): PaypalEnvStatus {
	const paypalEnv = paypalEnvForBillingEnv(env);
	const config = org.paypal_config;
	const envConfig = paypalEnv === "live" ? config?.live : config?.test;

	if (envConfig?.client_id && envConfig?.client_secret_enc) {
		return {
			connected: true,
			shared_account: false,
			client_id: maskClientId(envConfig.client_id),
			account_email: envConfig.account_email ?? null,
			webhook_id: envConfig.webhook_id ?? null,
			connected_at: envConfig.connected_at ?? null,
		};
	}

	// The org manages its own PayPal but not in this environment.  It is NOT
	// connected here — reporting the shared account instead would let the
	// platform bill live on behalf of an org that never connected live.
	const ownsPaypal = !!(config?.test || config?.live);
	if (ownsPaypal) {
		return {
			connected: false,
			shared_account: false,
			client_id: null,
			account_email: null,
			webhook_id: null,
			connected_at: null,
		};
	}

	const sharedClientId = process.env.PAYPAL_CLIENT_ID;
	const sharedSecret = process.env.PAYPAL_CLIENT_SECRET;
	if (sharedClientId && sharedSecret) {
		return {
			connected: true,
			shared_account: true,
			client_id: maskClientId(sharedClientId),
			account_email: null,
			webhook_id: process.env.PAYPAL_WEBHOOK_ID ?? null,
			connected_at: null,
		};
	}

	return {
		connected: false,
		shared_account: false,
		client_id: null,
		account_email: null,
		webhook_id: null,
		connected_at: null,
	};
}

/**
 * Check a client id / secret pair against PayPal and report the account it
 * controls.
 *
 * The connect endpoint verifies before it stores: an org that saved broken
 * credentials would fail at checkout time, long after the merchant thought
 * they were set up.
 */
export async function verifyPaypalCredentials({
	clientId,
	clientSecret,
	paypalEnv,
}: {
	clientId: string;
	clientSecret: string;
	paypalEnv: PaypalEnv;
}): Promise<{ accountEmail: string | null; accountId: string | null }> {
	const baseUrl = paypalBaseUrl(paypalEnv);
	const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

	const tokenRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
		method: "POST",
		headers: {
			Authorization: `Basic ${auth}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});

	if (!tokenRes.ok) {
		const text = await tokenRes.text();
		throw new Error(
			`PayPal rejected these credentials (${tokenRes.status}): ${text.slice(0, 200)}`,
		);
	}

	const tokenJson = (await tokenRes.json()) as { access_token: string };
	if (!tokenJson.access_token) {
		throw new Error("PayPal did not return an access token");
	}

	// The identity endpoint reports which account the credentials belong to.
	// A 404 here means the credentials work but the app has no identity
	// scope, which is not fatal — the account email just stays unknown.
	const infoRes = await fetch(
		`${baseUrl}/v1/identity/oauth2/userinfo?schema=paypalv1.1`,
		{
			headers: {
				Authorization: `Bearer ${tokenJson.access_token}`,
				"Content-Type": "application/json",
			},
		},
	);

	if (!infoRes.ok) {
		return { accountEmail: null, accountId: null };
	}

	const info = (await infoRes.json()) as {
		email?: string;
		user_id?: string;
		payer_id?: string;
	};
	return {
		accountEmail: info.email ?? null,
		accountId: info.user_id ?? info.payer_id ?? null,
	};
}

/**
 * The public webhook URL for an org — the id-less per-org route.  Signature
 * verification on that route tries each of the org's stored webhook ids, so
 * the URL works whether the id was auto-registered or pasted by hand, and it
 * is known before the webhook exists (auto-registration has no
 * chicken-and-egg problem).
 */
export function paypalOrgWebhookUrl(orgId: string): string {
	const base = (
		process.env.AUTUMN_PUBLIC_API_URL ??
		process.env.BETTER_AUTH_URL ??
		"http://localhost:8080"
	).replace(/\/+$/, "");
	return `${base}/webhooks/paypal/${orgId}`;
}

/**
 * Registers (or reuses) the org's PayPal webhook for one environment.
 *
 * Runs on connect so merchants don't paste a webhook id by hand: the webhook
 * is created against the id-less per-org URL with every event type MeterPal
 * handles, and the returned id is stored in `paypal_config.<env>.webhook_id`
 * — the same slot a manually-registered id lands in.
 *
 * Idempotent: an existing stored id short-circuits, and a previous create
 * whose DB write failed is recovered by listing the app's webhooks and
 * matching the URL instead of creating a duplicate.
 */
export async function ensurePaypalWebhook({
	org,
	env,
	client,
	persist,
}: {
	org: Organization;
	env: AppEnv;
	client: PaypalClient;
	/** Writes the webhook id into the org's config (caller owns persistence). */
	persist: (webhookId: string) => Promise<void>;
}): Promise<{ webhookId: string; created: boolean }> {
	const paypalEnv = paypalEnvForBillingEnv(env);
	const existingId =
		paypalEnv === "live"
			? org.paypal_config?.live?.webhook_id
			: org.paypal_config?.test?.webhook_id;
	if (existingId) return { webhookId: existingId, created: false };

	const url = paypalOrgWebhookUrl(org.id);

	// Recover an earlier create that never got persisted.
	const listed = await listWebhooks(client).catch(() => null);
	const prior = listed?.webhooks?.find((w) => w.url === url);
	if (prior?.id) {
		await persist(prior.id);
		return { webhookId: prior.id, created: false };
	}

	const webhook = await createWebhook({
		client,
		url,
		eventTypes: [...PAYPAL_WEBHOOK_EVENT_TYPES],
		idempotencyKey: `mp-webhook-${org.id}-${paypalEnv}`,
	});
	await persist(webhook.id);
	return { webhookId: webhook.id, created: true };
}
