// autumn/server/src/external/paypal/client.ts
//
// PayPal OAuth2 client_credentials wrapper.  Caches the access token in
// memory and refreshes ~5 minutes before expiry.  Falls back to a fresh
// fetch if a 401 comes back from PayPal.
//
// Spec: https://developer.paypal.com/api/rest/authentication
// Token TTL is ~32,400 s (≈9 hours).

const SANDBOX = "https://api-m.sandbox.paypal.com";
const LIVE = "https://api-m.paypal.com";

function baseUrl(): string {
  // PAYPAL_BASE_URL override exists for local end-to-end tests (mock PayPal);
  // production always uses the sandbox/live hosts below.
  if (process.env.PAYPAL_BASE_URL) return process.env.PAYPAL_BASE_URL;
  return process.env.PAYPAL_ENV === "live" ? LIVE : SANDBOX;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

interface TokenCache {
  token: string;
  expiresAtMs: number;
}

let cache: TokenCache | null = null;
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

async function getAccessToken(): Promise<string> {
  if (cache && Date.now() < cache.expiresAtMs - REFRESH_MARGIN_MS) {
    return cache.token;
  }

  const clientId = required("PAYPAL_CLIENT_ID");
  const clientSecret = required("PAYPAL_CLIENT_SECRET");
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
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

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cache = {
    token: json.access_token,
    expiresAtMs: Date.now() + json.expires_in * 1000,
  };
  return cache.token;
}

/**
 * Authenticated fetch to the PayPal REST API.  Auto-refreshes the token
 * on 401.  All requests get a fresh `PayPal-Request-Id` if `idempotencyKey`
 * is provided (PayPal dedupes for 72 hours).
 */
export async function paypalFetch<T = unknown>(
  path: string,
  init: RequestInit & { idempotencyKey?: string; retry?: boolean } = {},
): Promise<T> {
  const { idempotencyKey, retry, ...rest } = init;
  const token = await getAccessToken();

  const headers = new Headers(rest.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  if (idempotencyKey) headers.set("PayPal-Request-Id", idempotencyKey);

  const res = await fetch(`${baseUrl()}${path}`, { ...rest, headers });
  if (res.status === 401 && !retry) {
    // token may have been revoked; force refresh
    cache = null;
    return paypalFetch<T>(path, { ...init, retry: true });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`paypal ${path} ${res.status}: ${text.slice(0, 500)}`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const paypalBaseUrl = baseUrl;
export { getAccessToken };