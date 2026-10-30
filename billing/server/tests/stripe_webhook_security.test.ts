// autumn/server/tests/stripe_webhook_security.test.ts
//
// Unit tests for the real Stripe signature verification wrapper
// (server/src/external/stripe/webhookSecurity.ts).
//
// This replaces tests/test_webhook_security.py, which could never run: it
// tried `importlib.import_module("autumn.external.stripe.webhookSecurity")`
// against a TypeScript module, so every test errored with
// ModuleNotFoundError. The module is Bun-only, so the test has to be a Bun
// test.  Verified against https://docs.stripe.com/webhooks#verify-manually

import { describe, expect, test, beforeAll } from "bun:test";
import { createHmac } from "node:crypto";

const SECRET = "whsec_test_secret_value";

// The module reads STRIPE_WEBHOOK_SECRET at import time, so it must be set
// before the dynamic import below.
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

type Verifier = typeof import("../src/external/stripe/webhookSecurity.js");
let mod: Verifier;

beforeAll(async () => {
	mod = await import("../src/external/stripe/webhookSecurity.js");
});

function sign(body: string, timestamp: number): string {
	const signed = `${timestamp}.${body}`;
	const v1 = createHmac("sha256", SECRET).update(signed).digest("hex");
	return `t=${timestamp},v1=${v1}`;
}

describe("verifyStripeSignature", () => {
	test("accepts a correctly signed payload", () => {
		const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
		expect(mod.verifyStripeSignature(body, sign(body, Date.now() / 1000))).toBe(
			true,
		);
	});

	test("rejects a tampered body", () => {
		const original = JSON.stringify({ id: "evt_1", amount: 100 });
		const tampered = JSON.stringify({ id: "evt_1", amount: 1 });
		expect(
			mod.verifyStripeSignature(tampered, sign(original, Date.now() / 1000)),
		).toBe(false);
	});

	test("rejects a signature made with the wrong secret", () => {
		const body = JSON.stringify({ id: "evt_2" });
		const ts = Date.now() / 1000;
		const bad = createHmac("sha256", "whsec_wrong")
			.update(`${ts}.${body}`)
			.digest("hex");
		expect(mod.verifyStripeSignature(body, `t=${ts},v1=${bad}`)).toBe(false);
	});

	test("rejects a stale timestamp beyond the 5 minute tolerance", () => {
		const body = JSON.stringify({ id: "evt_3" });
		const old = Date.now() / 1000 - 6 * 60;
		expect(mod.verifyStripeSignature(body, sign(body, old))).toBe(false);
	});

	test("accepts a timestamp just inside the tolerance", () => {
		const body = JSON.stringify({ id: "evt_4" });
		const recent = Math.floor(Date.now() / 1000) - 60;
		expect(mod.verifyStripeSignature(body, sign(body, recent))).toBe(true);
	});

	test("rejects a malformed or missing header", () => {
		expect(mod.verifyStripeSignature("{}", "")).toBe(false);
		expect(mod.verifyStripeSignature("{}", "garbage")).toBe(false);
		expect(mod.verifyStripeSignature("{}", "t=123")).toBe(false);
	});

	test("rejects a non-numeric timestamp", () => {
		expect(mod.verifyStripeSignature("{}", "t=notanumber,v1=abcd")).toBe(false);
	});
});
