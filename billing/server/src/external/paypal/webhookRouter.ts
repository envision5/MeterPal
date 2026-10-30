// autumn/server/src/external/paypal/webhookRouter.ts
//
// Mounts the PayPal webhook endpoint on a Hono router.  Verifies the
// signature using verifyPaypalSignature() then dispatches to the event
// handlers in runPaypalWebhookHandlers.ts.
//
// Critical: this route reads the raw body BEFORE any JSON.parse.  PayPal
// explicitly requires byte-identical input for CRC32 computation:
// https://developer.paypal.com/api/rest/webhooks/rest

import { Hono } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { verifyPaypalSignature } from "./webhookSecurity.js";
import { handlePaypalEvent } from "./runPaypalWebhookHandlers.js";

export const paypalWebhookRouter = new Hono<HonoEnv>();

paypalWebhookRouter.post("/webhooks/paypal", async (c) => {
	// Use Hono's cached body accessor, not c.req.raw: baseMiddleware runs
	// c.req.json() ahead of this route, which consumes the raw stream (reading
	// c.req.raw here throws "Body already used"). Hono's arrayBuffer() replays
	// the cached bytes, still byte-identical for CRC32.
	const raw = Buffer.from(await c.req.arrayBuffer());

  const ok = await verifyPaypalSignature(raw, c.req.raw.headers);
  if (!ok) return c.text("invalid signature", 401);

  let event: { id: string; event_type: string; resource: unknown };
  try {
    event = JSON.parse(raw.toString("utf-8"));
  } catch {
    return c.text("invalid json", 400);
  }

  try {
    await handlePaypalEvent({
      id: event.id,
      type: event.event_type,
      resource: event.resource,
    });
  } catch (e) {
    // Returning 5xx triggers PayPal's 25-retry-over-3-days policy.
    // Log and return 500 so a transient failure gets retried.
    console.error(`paypal webhook ${event.id} ${event.event_type} failed`, e);
    return c.text("handler error", 500);
  }

  return c.text("ok", 200);
});