// billing/server/src/internal/setup/setupRouter.ts
//
// The onboarding wizard's API.
//
//   GET  /setup              the wizard's state
//   POST /setup/paypal-plan  create the PayPal counterpart of a plan
//   POST /setup/smoke-test   one real, metered, billed inference call
//
// Mounted under /organization, so these are /v1/organization/setup/...

import { Hono } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { handleCreatePaypalPlan } from "./handlers/handleCreatePaypalPlan.js";
import { handleGetSetupState } from "./handlers/handleGetSetupState.js";
import { handleRunSmokeTest } from "./handlers/handleRunSmokeTest.js";

export const setupRouter = new Hono<HonoEnv>();

setupRouter.get("/", ...handleGetSetupState);
setupRouter.post("/paypal-plan", ...handleCreatePaypalPlan);
setupRouter.post("/smoke-test", ...handleRunSmokeTest);
