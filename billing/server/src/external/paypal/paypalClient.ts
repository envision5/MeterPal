// autumn/server/src/external/paypal/paypalClient.ts
//
// Per-org PayPal REST client.
//
// Every merchant brings their own PayPal app, so the client id, the client
// secret and the webhook id belong to the ORG — not to the process.  A
// process-global client would let one merchant's subscription be created
// against another merchant's PayPal account.
//
// Access tokens are cached in Redis under `{orgId}:{env}:paypal_token`, not
// in process memory: the billing server is horizontally scalable, and a
// process-level cache is also a cross-tenant leak vector.
//
// An org with no `paypal_config` falls back to the PAYPAL_* environment
// variables, so the single-tenant deployment keeps working unchanged.
//
// Spec: https://developer.paypal.com/api/rest/authentication
// Token TTL is ~32,400 s (≈9 hours).

import { AppEnv, type Organization } from "@autumn/shared";
import { getMiscRedis } from "@/external/redis/miscCache/getMiscRedis.js";
import { decryptData } from "@/utils/encryptUtils.js";

const SANDBOX = "https://api-m.sandbox.paypal.com";
const LIVE = "https://api-m.paypal.com";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export interface PaypalFetchInit extends RequestInit {
	/** PayPal dedupes on this header for 72 hours. */
	idempotencyKey?: string;
	/** Internal: set when the request is already a 401 retry. */
	retry?: boolean;
}

export interface PaypalClient {
	/** The PayPal REST host this client talks to. */
	readonly baseUrl: string;
	/** True when the credentials came from the org's own row. */
	readonly fromOrg: boolean;
	fetch<T = unknown>(path: string, init?: PaypalFetchInit): Promise<T>;
	getAccessToken(): Promise<string>;
}

export type PaypalConnection = {
	clientId: string;
	clientSecret: string;
	/** Which PayPal environment (sandbox or live) this connection talks to. */
	paypalEnv: "sandbox" | "live";
	/** The webhook id the org registered with PayPal. */
	webhookId?: string | null;
	/** The PayPal account this client acts on behalf of. */
	accountEmail?: string | null;
	/** True when the connection came from the org's own row. */
	fromOrg: boolean;
};

/**
 * The org's own credentials, without decrypting the secret.
 *
 * The org row wins.  An org without one falls back to the process-wide
 * PAYPAL_* variables, which is how the single-tenant deployment and the demo
 * stack are wired today — that fallback answers for every billing env,
 * because a process-wide credential knows nothing about billing envs.
 *
 * Once an org manages its own PayPal the fallback is off for good: an org
 * that connected only a sandbox app is NOT connected in live, rather than
 * silently billing live through the shared platform account.
 */
function findConnection({
	org,
	env,
}: {
	org: Organization;
	env: AppEnv;
}): Omit<PaypalConnection, "clientSecret"> & {
	clientSecretEnc: string;
	encrypted: boolean;
} | null {
	const config = org.paypal_config;
	const ownsPaypal = !!(config?.test || config?.live);

	if (ownsPaypal) {
		const envConfig = env === AppEnv.Live ? config?.live : config?.test;
		if (!envConfig?.client_id || !envConfig?.client_secret_enc) return null;
		return {
			clientId: envConfig.client_id,
			clientSecretEnc: envConfig.client_secret_enc,
			encrypted: true,
			paypalEnv: env === AppEnv.Live ? "live" : "sandbox",
			webhookId: envConfig.webhook_id ?? null,
			accountEmail: envConfig.account_email ?? null,
			fromOrg: true,
		};
	}

	const clientId = process.env.PAYPAL_CLIENT_ID;
	const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
	if (!clientId || !clientSecret) return null;
	return {
		clientId,
		clientSecretEnc: clientSecret,
		encrypted: false,
		paypalEnv: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox",
		webhookId: process.env.PAYPAL_WEBHOOK_ID ?? null,
		accountEmail: null,
		fromOrg: false,
	};
}

/** True when this org can bill through PayPal in `env`. */
export function hasPaypalConnection({
	org,
	env,
}: {
	org: Organization;
	env: AppEnv;
}): boolean {
	return findConnection({ org, env }) !== null;
}

/**
 * The PayPal environment an org's connection targets in `env`.
 *
 * An org with its own config answers for the billing env it was asked about;
 * an org without one follows PAYPAL_ENV.
 */
export function paypalEnvForOrg({
	org,
	env,
}: {
	org: Organization;
	env: AppEnv;
}): "sandbox" | "live" {
	const config = org.paypal_config;
	if (config?.test || config?.live) {
		return env === AppEnv.Live ? "live" : "sandbox";
	}
	return process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";
}

/**
 * The billing env whose stored webhook id matches `webhookId`.
 *
 * A webhook URL carries only the org and the webhook id, and an org has one
 * webhook per environment — so the id itself says which of the org's PayPal
 * connections the event belongs to.  Returns null when the id belongs to
 * neither, which means the org never registered it.
 */
export function paypalEnvForWebhookId({
	org,
	webhookId,
}: {
	org: Organization;
	webhookId: string;
}): AppEnv | null {
	const config = org.paypal_config;
	if (config?.test?.webhook_id === webhookId) return AppEnv.Sandbox;
	if (config?.live?.webhook_id === webhookId) return AppEnv.Live;
	return null;
}

/** The org's PayPal connection, with the client secret decrypted. */
export function resolvePaypalConnection({
	org,
	env,
}: {
	org: Organization;
	env: AppEnv;
}): PaypalConnection | null {
	const found = findConnection({ org, env });
	if (!found) return null;
	const { clientSecretEnc, encrypted, ...rest } = found;
	return {
		...rest,
		clientSecret: encrypted ? decryptData(clientSecretEnc) : clientSecretEnc,
	};
}

function tokenCacheKey(orgId: string, env: AppEnv, paypalEnv: string): string {
	return `${orgId}:${env}:paypal_token:${paypalEnv}`;
}

type CachedToken = { token: string; expiresAtMs: number };

async function readCachedToken(key: string): Promise<CachedToken | null> {
	try {
		const raw = await getMiscRedis().get(key);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as CachedToken;
		return parsed?.token ? parsed : null;
	} catch {
		// A cache miss is the normal path; a broken cache must not block
		// the call.
		return null;
	}
}

async function writeCachedToken(key: string, value: CachedToken): Promise<void> {
	try {
		const ttlMs = Math.max(value.expiresAtMs - Date.now(), 60_000);
		await getMiscRedis().set(key, JSON.stringify(value), "PX", ttlMs);
	} catch {
		// Losing the cache only costs one extra token request.
	}
}

async function dropCachedToken(key: string): Promise<void> {
	try {
		await getMiscRedis().del(key);
	} catch {
		// best effort
	}
}

/**
 * The PayPal REST host for an environment.
 *
 * PAYPAL_BASE_URL override exists for local end-to-end tests (mock PayPal);
 * production always uses the sandbox/live hosts.
 */
export function paypalBaseUrl(paypalEnv: "sandbox" | "live"): string {
	return (
		process.env.PAYPAL_BASE_URL ??
		(paypalEnv === "live" ? LIVE : SANDBOX)
	);
}

/**
 * Build the PayPal client for an org.
 *
 * Throws when the org has no usable PayPal credentials — an unmetered,
 * unbilled PayPal call is worse than a clear error.
 */
export async function getPaypalClient({
	org,
	env,
}: {
	org: Organization;
	env: AppEnv;
}): Promise<PaypalClient> {
	const connection = resolvePaypalConnection({ org, env });
	if (!connection) {
		throw new Error(
			`PayPal is not connected for org ${org.id} (${env}). Connect PayPal in the dashboard, or set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.`,
		);
	}
	return createPaypalClient({ org, env, connection });
}

/**
 * Build a client from an already-resolved connection.
 *
 * Exposed for callers that resolved the connection themselves (the webhook
 * handler resolves the org from the URL before it can know the connection).
 */
export function createPaypalClient({
	org,
	env,
	connection,
}: {
	org: Organization;
	env: AppEnv;
	connection: PaypalConnection;
}): PaypalClient {
	// PAYPAL_BASE_URL override exists for local end-to-end tests (mock PayPal);
	// production always uses the sandbox/live hosts below.
	const baseUrl = paypalBaseUrl(connection.paypalEnv);
	const cacheKey = tokenCacheKey(org.id, env, connection.paypalEnv);

	const requestToken = async (): Promise<CachedToken> => {
		const auth = Buffer.from(
			`${connection.clientId}:${connection.clientSecret}`,
		).toString("base64");

		const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${auth}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "grant_type=client_credentials",
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`paypal oauth failed ${res.status}: ${text.slice(0, 200)}`);
		}

		const json = (await res.json()) as {
			access_token: string;
			expires_in: number;
		};
		return {
			token: json.access_token,
			expiresAtMs: Date.now() + json.expires_in * 1000,
		};
	};

	const getAccessToken = async (): Promise<string> => {
		const cached = await readCachedToken(cacheKey);
		if (cached && Date.now() < cached.expiresAtMs - REFRESH_MARGIN_MS) {
			return cached.token;
		}
		const fresh = await requestToken();
		await writeCachedToken(cacheKey, fresh);
		return fresh.token;
	};

	const send = async (
		path: string,
		init: PaypalFetchInit,
		token: string,
	): Promise<Response> => {
		const { idempotencyKey, retry, ...rest } = init;
		const headers = new Headers(rest.headers);
		headers.set("Authorization", `Bearer ${token}`);
		headers.set("Content-Type", "application/json");
		if (idempotencyKey) headers.set("PayPal-Request-Id", idempotencyKey);
		return fetch(`${baseUrl}${path}`, { ...rest, headers });
	};

	const fetchImpl = async <T>(
		path: string,
		init: PaypalFetchInit = {},
	): Promise<T> => {
		let res = await send(path, init, await getAccessToken());

		if (res.status === 401 && !init.retry) {
			// The token may have been revoked — force a refresh and retry once.
			await dropCachedToken(cacheKey);
			res = await send(path, init, await getAccessToken());
		}

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`paypal ${path} ${res.status}: ${text.slice(0, 500)}`);
		}

		if (res.status === 204) return undefined as T;
		return (await res.json()) as T;
	};

	return {
		baseUrl,
		fromOrg: connection.fromOrg,
		fetch: fetchImpl,
		getAccessToken,
	};
}
