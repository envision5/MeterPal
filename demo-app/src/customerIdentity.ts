// Signed customer identity.
//
// The server no longer trusts a raw customer id from the browser: every
// customer-scoped route verifies an HMAC token this module holds.  Tokens are
// minted by the server for the allowlisted demo personas only
// (GET /api/customer-tokens) — the browser can never claim an arbitrary
// customer id.

let tokens: Record<string, string> = {};

/** Fetch the signed tokens.  Returns the server's demo persona list. */
export async function loadCustomerTokens(): Promise<string[]> {
	const res = await fetch("/api/customer-tokens");
	if (!res.ok) throw new Error(`customer-tokens -> ${res.status}`);
	const data = await res.json();
	tokens = data?.tokens ?? {};
	return Array.isArray(data?.customers) ? data.customers : [];
}

/** Auth headers presenting the signed token for `customerId`. */
export function authHeaders(customerId: string): Record<string, string> {
	const token = tokens[customerId];
	if (!token) {
		throw new Error(`no signed customer token for '${customerId}' — call loadCustomerTokens() first`);
	}
	return { "x-meterpal-customer": token };
}
