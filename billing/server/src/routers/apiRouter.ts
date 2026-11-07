import { Hono } from "hono";
import { legacyAnalyticsRouter } from "@/internal/analytics/legacyAnalyticsRouter.js";
import { eventsRouter } from "@/internal/events/eventsRouter.js";
import { componentsRouter } from "@/internal/misc/components/componentsRouter.js";
import { configsRouter } from "@/internal/misc/configs/configsRouter.js";
import { analyticsMiddleware } from "../honoMiddlewares/analyticsMiddleware.js";
import { apiVersionMiddleware } from "../honoMiddlewares/apiVersionMiddleware.js";
import { criticalDbMiddleware } from "../honoMiddlewares/criticalDbMiddleware.js";
import { customerBlockMiddleware } from "../honoMiddlewares/customerBlockMiddleware.js";
import { customerJwtVersionMiddleware } from "../honoMiddlewares/customerJwtVersionMiddleware.js";
import { idempotencyMiddleware } from "../honoMiddlewares/idempotencyMiddleware.js";
import { orgConfigMiddleware } from "../honoMiddlewares/orgConfigMiddleware.js";
import { orgRedisMiddleware } from "../honoMiddlewares/orgRedisMiddleware.js";
import { planAliasMiddleware } from "../honoMiddlewares/planAliasMiddleware.js";
import { queryMiddleware } from "../honoMiddlewares/queryMiddleware.js";
import { rateLimitMiddleware } from "../honoMiddlewares/rateLimitMiddleware.js";
import { refreshCacheMiddleware } from "../honoMiddlewares/refreshCacheMiddleware.js";
import { refreshProductsCacheMiddleware } from "../honoMiddlewares/refreshProductsCacheMiddleware.js";
import { requestBlockMiddleware } from "../honoMiddlewares/requestBlockMiddleware.js";
import { responseFilterMiddleware } from "../honoMiddlewares/responseFilter/responseFilterMiddleware.js";
import { rolloutMiddleware } from "../honoMiddlewares/rolloutMiddleware.js";
import { secretKeyMiddleware } from "../honoMiddlewares/secretKeyMiddleware.js";

import { traceEnrichMiddleware } from "../honoMiddlewares/traceMiddleware.js";
import type { HonoEnv } from "../honoUtils/HonoEnv.js";
// [REWARDS DISABLED] Unmounted the rewards/referral public API.
// To re-enable: uncomment the four imports below, the four route mounts
// (search "[REWARDS DISABLED]"), and the referralRpcRouter lines in rpcRouter.ts.
// import {
// 	redemptionRouter,
// 	referralRouter,
// } from "../internal/api/rewards/referralRouter";
// import { rewardProgramRouter } from "../internal/api/rewards/rewardProgramRouter";
// import { rewardRouter } from "../internal/api/rewards/rewardRouter";
import { balancesRouter } from "../internal/balances/balancesRouter";
import { billingRouter } from "../internal/billing/billingRouter";
import { paypalRouter } from "../internal/billing/paypal/paypalRouter";
import { cusRouter } from "../internal/customers/cusRouter";
import { entityRouter } from "../internal/entities/entityRouter";
import { featureRouter } from "../internal/features/featureRouter";
import { servedModelRouter } from "../internal/models/servedModelRouter";
import { salesAgentRouter } from "../internal/salesAgent/salesAgentRouter";
import { honoOrgRouter } from "../internal/orgs/orgRouter";
import { platformBetaRouter } from "../internal/platform/platformBeta/platformBetaRouter";
import {
	honoProductBetaRouter,
	honoProductRouter,
} from "../internal/products/productRouter.js";
import { rpcRouter } from "./rpcRouter.js";

export const apiRouter = new Hono<HonoEnv>();

apiRouter.use("*", criticalDbMiddleware);
apiRouter.use("*", responseFilterMiddleware);
apiRouter.use("*", secretKeyMiddleware);
apiRouter.use("*", planAliasMiddleware);
apiRouter.use("*", requestBlockMiddleware);
apiRouter.use("*", orgConfigMiddleware);
apiRouter.use("*", rolloutMiddleware);
apiRouter.use("*", orgRedisMiddleware);
apiRouter.use("*", apiVersionMiddleware);
apiRouter.use("*", customerJwtVersionMiddleware);
apiRouter.use("*", traceEnrichMiddleware);
apiRouter.use("*", refreshCacheMiddleware);
apiRouter.use("*", refreshProductsCacheMiddleware);
apiRouter.use("*", analyticsMiddleware);
apiRouter.use("*", customerBlockMiddleware);
apiRouter.use("*", rateLimitMiddleware);
apiRouter.use("*", queryMiddleware());
apiRouter.use("*", idempotencyMiddleware);

apiRouter.route("", rpcRouter);
apiRouter.route("", billingRouter);
apiRouter.route("", paypalRouter);
apiRouter.route("", balancesRouter);
apiRouter.route("", servedModelRouter);
apiRouter.route("", entityRouter);
apiRouter.route("/customers", cusRouter);
apiRouter.route("/sales-agent", salesAgentRouter);

apiRouter.route("/products_beta", honoProductBetaRouter);
apiRouter.route("/products", honoProductRouter);
apiRouter.route("/plans", honoProductRouter);
apiRouter.route("/features", featureRouter);

apiRouter.route("", balancesRouter);

apiRouter.route("/platform", platformBetaRouter);
apiRouter.route("/platform/beta", platformBetaRouter);

apiRouter.route("/organization", honoOrgRouter);

// [REWARDS DISABLED] Public rewards/referral/redemption routes unmounted —
// see the import block above for re-enable instructions.
// apiRouter.route("/rewards", rewardRouter);
// apiRouter.route("/reward_programs", rewardProgramRouter);
// apiRouter.route("/referrals", referralRouter);
// apiRouter.route("/redemptions", redemptionRouter);
apiRouter.route("/query", legacyAnalyticsRouter);
apiRouter.route("/events", eventsRouter);

apiRouter.route("/configs", configsRouter);
apiRouter.route("/components", componentsRouter);
