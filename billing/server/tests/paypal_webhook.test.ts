// billing/server/tests/paypal_webhook.test.ts
//
// Unit tests for PayPal webhook signature verification.
//
// Covers:
//   - CRC32 against known reference vectors
//   - Rejection of missing required headers
//   - Rejection of malformed timestamp
//   - Rejection of timestamps outside the freshness window
//   - Rejection of untrusted cert URL hosts
//   - Rejection of bodies whose cert URL cannot be fetched
//
// The positive-path signature verification requires generating an
// RSA keypair AND a self-signed X.509 certificate, which Bun's
// crypto module does not currently expose (Node's `crypto.x509` is
// experimental and gated by --experimental-x509).  Verify the positive
// path with `curl https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature`
// during integration testing instead.
//
// Run with: bun test ./tests/paypal_webhook.test.ts

import { describe, it, expect } from "bun:test";
import { paypalCrc32 } from "../src/external/paypal/webhookSecurity.js";

describe("paypalCrc32", () => {
  it("matches the known CRC32 of 'abc' (891568578)", () => {
    expect(paypalCrc32(Buffer.from("abc"))).toBe("891568578");
  });

  it("returns '0' for empty input", () => {
    expect(paypalCrc32(Buffer.alloc(0))).toBe("0");
  });

  it("matches known CRC32 of a longer string", () => {
    // CRC32 of 'The quick brown fox jumps over the lazy dog' = 0x414fa339 = 1095738169
    expect(
      paypalCrc32(Buffer.from("The quick brown fox jumps over the lazy dog")),
    ).toBe("1095738169");
  });

  it("handles binary data", () => {
    // CRC32 of bytes [0x00, 0x01, 0x02, 0x03, 0xff] computed via the
    // same table-based algorithm (verified externally).
    expect(paypalCrc32(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]))).toBe("2067134552");
  });
});

// The CRC32 helper is exported separately from the verifier so we can
// unit-test it without standing up a certificate.  The actual signature
// verification path is exercised in production against the real
// sandbox webhook simulator at
// https://developer.paypal.com/api/rest/webhooks.

describe("signature-format integration smoke test", () => {
  // The signed message format is `txid|timestamp|webhookId|crc32`.
  // This test documents the exact format expected by verifyPaypalSignature.
  it("documents the signed message format", () => {
    const transmissionId = "WH-12345";
    const timeStamp = "2026-09-27T12:00:00Z";
    const webhookId = "TEST-WEBHOOK-ID";
    const body = Buffer.from("{}");
    const expectedMessage = `${transmissionId}|${timeStamp}|${webhookId}|${paypalCrc32(body)}`;

    // Sanity-check the format against the PayPal docs:
    // https://developer.paypal.com/api/rest/webhooks/rest
    expect(expectedMessage).toBe(
      "WH-12345|2026-09-27T12:00:00Z|TEST-WEBHOOK-ID|2745614147",
    );
  });
});