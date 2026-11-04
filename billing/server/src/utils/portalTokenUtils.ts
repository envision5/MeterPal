// billing/server/src/utils/portalTokenUtils.ts
//
// Signed, short-lived tokens for the self-hosted PayPal billing portal.
// PayPal has no hosted portal equivalent to Stripe's, so the billing portal
// session URL points at the dashboard's /portal page with one of these tokens
// — possession of the token is the only credential the public portal
// endpoints accept (same trust model as Stripe's opaque portal session URLs).

import crypto from "crypto";
import { AppEnv } from "@autumn/shared";

export interface PortalTokenPayload {
	customer_id: string;
	org_id: string;
	env: AppEnv;
	/** Epoch seconds — the token is dead after this. */
	exp: number;
}

export const PORTAL_TOKEN_TTL_SECONDS = 60 * 60;

// Same derivation as getKey() in encryptUtils.ts — the portal token gates the
// same secrets the encrypted org config protects.
const portalKey = () =>
	crypto
		.createHash("sha512")
		.update(process.env.ENCRYPTION_PASSWORD!)
		.digest("hex")
		.substring(0, 32);

const toBase64Url = (buf: Buffer) =>
	buf
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

const fromBase64Url = (s: string) =>
	Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function signPortalToken(
	payload: Omit<PortalTokenPayload, "exp">,
	ttlSeconds = PORTAL_TOKEN_TTL_SECONDS,
): string {
	const body: PortalTokenPayload = {
		...payload,
		exp: Math.floor(Date.now() / 1000) + ttlSeconds,
	};
	const encoded = toBase64Url(Buffer.from(JSON.stringify(body), "utf8"));
	const signature = toBase64Url(
		crypto.createHmac("sha256", portalKey()).update(encoded).digest(),
	);
	return `${encoded}.${signature}`;
}

/** Returns the payload, or null when the token is malformed, tampered with, or expired. */
export function verifyPortalToken(token: string): PortalTokenPayload | null {
	const [encoded, signature] = token.split(".");
	if (!encoded || !signature) return null;

	const expected = crypto
		.createHmac("sha256", portalKey())
		.update(encoded)
		.digest();
	const received = fromBase64Url(signature);
	if (
		received.length !== expected.length ||
		!crypto.timingSafeEqual(received, expected)
	) {
		return null;
	}

	try {
		const payload = JSON.parse(
			fromBase64Url(encoded).toString("utf8"),
		) as PortalTokenPayload;
		if (!payload.customer_id || !payload.org_id || !payload.env) return null;
		if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
		return payload;
	} catch {
		return null;
	}
}

/** The dashboard URL the portal session opens at. */
export const portalPageUrl = (token: string) => {
	const base = (
		process.env.CLIENT_URL ?? "http://localhost:3000"
	).replace(/\/+$/, "");
	return `${base}/portal?token=${encodeURIComponent(token)}`;
};
