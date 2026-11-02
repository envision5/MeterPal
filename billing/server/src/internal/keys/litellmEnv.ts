// billing/server/src/internal/keys/litellmEnv.ts
//
// Where the LiteLLM gateway lives and how to talk to it.
//
// The LiteLLM master key has to be the SAME value for the gateway and this
// server.  gateway/.env is the canonical source: the gateway process reads
// that file at startup, so a key read from it is guaranteed to match and
// there is only ever one copy of the secret.  A second copy in this
// server's .env is exactly how the two drifted apart before.
//
// The environment still wins, which is how a deployed instance supplies it.
// The file is a LOCAL-DEV fallback only.
//
// These helpers are read lazily: webhook handlers import them dynamically,
// and a missing bridge config must fail that one operation -- not module
// load.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

let gatewayEnvCache: Record<string, string> | null = null;

export function gatewayEnv(): Record<string, string> {
	if (gatewayEnvCache) return gatewayEnvCache;
	const path =
		process.env.LITELLM_ENV_FILE ??
		resolve(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"..",
			"..",
			"..",
			"gateway",
			".env",
		);
	gatewayEnvCache = existsSync(path) ? parse(readFileSync(path)) : {};
	return gatewayEnvCache;
}

export function requiredEnv(name: string): string {
	const v = process.env[name] ?? gatewayEnv()[name];
	if (!v) {
		throw new Error(`Missing required env var: ${name}`);
	}
	return v;
}

/** The gateway's base URL, e.g. http://localhost:4000 */
export function litellmBase(): string {
	return requiredEnv("LITELLM_BASE_URL");
}

/** The gateway's admin key. Never logged. */
export function litellmMasterKey(): string {
	return requiredEnv("LITELLM_MASTER_KEY");
}

/**
 * The feature the gateway meters against.
 *
 * Read from the gateway's own env so there is exactly one definition: the
 * bridge checks and settles on this feature, so anything reading a balance
 * here must read the same one.
 */
export function litellmFeatureId(): string {
	return (
		process.env.PAB_FEATURE_ID ??
		gatewayEnv().PAB_FEATURE_ID ??
		"ai_tokens"
	);
}

/**
 * The smallest balance a customer may start a call with.
 *
 * The bridge refuses a call below this, so a 402 from the gateway means the
 * customer is under it.  Read from the gateway's env for the same reason as
 * the feature id: one definition.
 */
export function litellmRequiredBalance(): number {
	const raw =
		process.env.PAB_REQUIRED_BALANCE ??
		gatewayEnv().PAB_REQUIRED_BALANCE ??
		"1.0";
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : 1;
}

/**
 * The shared secret the hosted gateway presents to this API.
 *
 * The gateway serves every merchant, so it cannot present one merchant's
 * secret key when it bills another.  It presents this instead and names the
 * tenant it resolved from the caller's virtual key; the tenant is then
 * trusted because the key itself is the only thing that can produce it.
 *
 * Empty means the gateway is not trusted: calls from it are refused rather
 * than billed against the wrong tenant.
 */
export function gatewayTrustSecret(): string {
	return (
		process.env.PAB_TRUST_SECRET ?? gatewayEnv().PAB_TRUST_SECRET ?? ""
	);
}
