// billing/server/src/internal/studio/studioRouter.ts
//
// The server side of the AG Studio surface.
//
// Three routes:
//
//   POST /data      the data source the studio reads (usage facts and raw events)
//   POST /ai        one metered turn of the agent loop
//   POST /customers the customers that actually have usage, for the picker
//
// Both are session-authenticated like the rest of the dashboard's internal
// routes, mounted under the internal router.

import { Hono } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { handleStudioAi } from "./handleStudioAi.js";
import { handleStudioCustomers } from "./handleStudioCustomers.js";
import { handleStudioData } from "./handleStudioData.js";

export const studioRouter = new Hono<HonoEnv>();

studioRouter.post("/data", ...handleStudioData);
studioRouter.post("/ai", ...handleStudioAi);
studioRouter.post("/customers", ...handleStudioCustomers);
