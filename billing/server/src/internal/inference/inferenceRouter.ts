// billing/server/src/internal/inference/inferenceRouter.ts
//
// The MeterPal inference API.
//
// These routes authenticate themselves rather than going through the
// standard secret-key middleware chain, because they accept two kinds of
// credential: the merchant's secret key and a per-customer virtual key.
// The chain in apiRouter only understands the first.

import { Hono } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { handleChatCompletions } from "./handlers/handleChatCompletions.js";
import { handleGetKey } from "./handlers/handleGetKey.js";
import { handleProvisionKey } from "./handlers/handleProvisionKey.js";

export const inferenceRouter = new Hono<HonoEnv>();

inferenceRouter.post("/chat/completions", handleChatCompletions);
inferenceRouter.post("/keys", handleProvisionKey);
inferenceRouter.get("/keys/:customer_id", handleGetKey);
