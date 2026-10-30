// autumn/server/src/external/paypal/webhookSecurity.ts
//
// PayPal webhook signature verification.
//
// Spec: https://developer.paypal.com/api/rest/webhooks/rest
//
// PayPal sends four headers.  The signed string is:
//   <crc32_decimal> | <transmission_id> | <transmission_time> | <webhook_id>
// Signed with SHA256withRSA using the public key in the X.509 cert at
// `paypal-cert-url`.  The cert is downloaded and cached locally because
// PayPal rotates them over time.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";

// CRC32 implementation (table-based, matches PayPal's spec).  Avoids
// pulling `buffer-crc32` to keep the dependency surface small.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (c >>> 1) ^ 0xedb88320 : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC32_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ 0xffffffff) >>> 0;
}

const CACHE_DIR = process.env.PAYPAL_CERT_CACHE_DIR ?? "./.cache/paypal-certs";
const WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID ?? "";

async function getCert(certUrl: string): Promise<string> {
  if (!certUrl.startsWith("https://api-m.sandbox.paypal.com") &&
      !certUrl.startsWith("https://api-m.paypal.com")) {
    throw new Error(`untrusted paypal-cert-url: ${certUrl}`);
  }
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const key = certUrl.replace(/[^a-z0-9]+/gi, "-");
  const cached = path.join(CACHE_DIR, `${key}.pem`);
  try {
    return await fs.readFile(cached, "utf-8");
  } catch {
    // not cached — fall through to download
  }
  const res = await fetch(certUrl);
  if (!res.ok) throw new Error(`paypal cert download ${res.status}`);
  const body = await res.text();
  await fs.writeFile(cached, body);
  return body;
}

export interface VerifyOpts {
  /** Webhook ID from the REST app's webhook listing. */
  webhookId?: string;
  /** Maximum allowed age (ms) of `paypal-transmission-time`.  Default 10 min. */
  maxAgeMs?: number;
}

/**
 * Verify a PayPal webhook request.  MUST be called against the raw
 * request body, NOT against a JSON.parse'd-and-reserialised copy.
 * Returns true iff the signature is valid and within the time window.
 */
export async function verifyPaypalSignature(
  rawBody: Buffer,
  headers: Headers,
  opts: VerifyOpts = {},
): Promise<boolean> {
  const transmissionId = headers.get("paypal-transmission-id");
  const transmissionTime = headers.get("paypal-transmission-time");
  const certUrl = headers.get("paypal-cert-url");
  const sigB64 = headers.get("paypal-transmission-sig");
  const webhookId = opts.webhookId ?? WEBHOOK_ID;
  const maxAgeMs = opts.maxAgeMs ?? 10 * 60 * 1000;

  if (!transmissionId || !transmissionTime || !certUrl || !sigB64) return false;
  if (!webhookId) {
    throw new Error("PAYPAL_WEBHOOK_ID env var is required for webhook verification");
  }

  // Timestamp freshness (reject replays older than maxAgeMs)
  const tsMs = Date.parse(transmissionTime);
  if (!Number.isFinite(tsMs)) return false;
  if (Math.abs(Date.now() - tsMs) > maxAgeMs) return false;

  const crc = crc32(rawBody);
  const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc}`;

  let certPem: string;
  try {
    certPem = await getCert(certUrl);
  } catch {
    return false;
  }

  try {
    const verifier = crypto.createVerify("SHA256");
    verifier.update(message, "utf8");
    verifier.end();
    return verifier.verify(certPem, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

/**
 * Compute the CRC32 of a buffer as a decimal string (PayPal format).
 * Exposed for tests and for the webhook handlers that log it.
 */
export function paypalCrc32(buf: Buffer): string {
  return String(crc32(buf));
}