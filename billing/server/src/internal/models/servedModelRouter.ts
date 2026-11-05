// billing/server/src/internal/models/servedModelRouter.ts
//
// The merchant's price sheet.
//
//   GET    /v1/served_models            the org's rows
//   POST   /v1/served_models            create or update one row
//   DELETE /v1/served_models/:model_id  drop one row
//   GET    /v1/served_models/available  the models the merchant can pick from
//
//   POST   /v1/served_models/:model_id/deployments
//   PATCH  /v1/served_models/:model_id/deployments/:deployment_id
//   DELETE /v1/served_models/:model_id/deployments/:deployment_id
//
// The gateway reads the same rows through GET /v1/catalog.

import { Hono } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { handleCreateDeployment } from "./handlers/handleCreateDeployment.js";
import { handleDeleteDeployment } from "./handlers/handleDeleteDeployment.js";
import { handleDeleteServedModel } from "./handlers/handleDeleteServedModel.js";
import { handleGetAvailableModels } from "./handlers/handleGetAvailableModels.js";
import { handleGetCatalog } from "./handlers/handleGetCatalog.js";
import { handleGetModelMarkup } from "./handlers/handleGetModelMarkup.js";
import { handleListServedModels } from "./handlers/handleListServedModels.js";
import { handleUpdateDeployment } from "./handlers/handleUpdateDeployment.js";
import { handleUpsertServedModel } from "./handlers/handleUpsertServedModel.js";

export const servedModelRouter = new Hono<HonoEnv>();

servedModelRouter.get("/served_models", ...handleListServedModels);
servedModelRouter.get("/served_models/available", ...handleGetAvailableModels);
servedModelRouter.get("/served_models/markup", ...handleGetModelMarkup);
servedModelRouter.post("/served_models", ...handleUpsertServedModel);
servedModelRouter.delete("/served_models/:model_id", ...handleDeleteServedModel);

// Gateway deployments: the instances behind a served model.
servedModelRouter.post(
	"/served_models/:model_id/deployments",
	...handleCreateDeployment,
);
servedModelRouter.patch(
	"/served_models/:model_id/deployments/:deployment_id",
	...handleUpdateDeployment,
);
servedModelRouter.delete(
	"/served_models/:model_id/deployments/:deployment_id",
	...handleDeleteDeployment,
);

// The gateway's view: GET /v1/catalog
servedModelRouter.get("/catalog", ...handleGetCatalog);
