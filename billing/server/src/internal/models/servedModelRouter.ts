// billing/server/src/internal/models/servedModelRouter.ts
//
// The merchant's price sheet.
//
//   GET    /v1/served_models            the org's rows
//   POST   /v1/served_models            create or update one row
//   DELETE /v1/served_models/:model_id  drop one row
//   GET    /v1/served_models/available  the models the merchant can pick from
//
// The gateway reads the same rows through GET /v1/catalog.

import { Hono } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { handleDeleteServedModel } from "./handlers/handleDeleteServedModel.js";
import { handleGetAvailableModels } from "./handlers/handleGetAvailableModels.js";
import { handleGetCatalog } from "./handlers/handleGetCatalog.js";
import { handleListServedModels } from "./handlers/handleListServedModels.js";
import { handleUpsertServedModel } from "./handlers/handleUpsertServedModel.js";

export const servedModelRouter = new Hono<HonoEnv>();

servedModelRouter.get("/served_models", ...handleListServedModels);
servedModelRouter.get("/served_models/available", ...handleGetAvailableModels);
servedModelRouter.post("/served_models", ...handleUpsertServedModel);
servedModelRouter.delete("/served_models/:model_id", ...handleDeleteServedModel);

// The gateway's view: GET /v1/catalog
servedModelRouter.get("/catalog", ...handleGetCatalog);
