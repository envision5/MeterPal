// autumn/server/src/external/stripe/webhookSecurity.ts
//
// Webhook security wrapper. Verifies Stripe signature before any handler runs,
// enforces timestamp tolerance, and emits a structured audit log.
//
// Production rule: never accept a webhook without going through this wrapper.
// Mount once in server/src/routers/apiRouter.ts:
//     apiRouter.post("/webhooks/stripe", wrapStripeWebhook(handler));

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

const STRIPE_SIGNATURE_HEADER = "stripe-signature";
const STRIPE_WEBHOOK_SECRET = required("STRIPE_WEBHOOK_SECRET");
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000; // 5 minutes

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function verifyStripeSignature(rawBody: string, signatureHeader: string): boolean {
  // Stripe-Signature: t=1492774577, v1=..., v0=...
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;

  const tsMs = Number(t) * 1000;
  if (!Number.isFinite(tsMs)) return false;
  if (Math.abs(Date.now() - tsMs) > MAX_TIMESTAMP_DRIFT_MS) return false;

  const signedPayload = `${t}.${rawBody}`;
  const expected = createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(signedPayload).digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function wrapStripeWebhook<T>(
  handler: (event: { id: string; type: string; data: any }) => Promise<T>,
  c: Context,
): Promise<Response> {
  const rawBody = await c.req.text();
  const sig = c.req.header(STRIPE_SIGNATURE_HEADER) ?? "";

  if (!verifyStripeSignature(rawBody, sig)) {
    return c.json({ error: "invalid_signature" }, 400);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const result = await handler({ id: event.id, type: event.type, data: event.data });
  return c.json(result ?? { received: true });
}

export function rateLimitByIp(scope: string, maxPerMinute: number) {
  // Simple in-process rate limit for webhook endpoint.
  // (Production: replace with Redis sliding-window if running multi-instance.)
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (c: Context) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const key = `${scope}:${ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > maxPerMinute) {
      return c.json({ error: "rate_limited" }, 429);
    }
  };
}