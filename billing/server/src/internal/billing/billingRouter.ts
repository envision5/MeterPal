import { Hono } from "hono";
import { createRouterRateLimiter } from "@/honoMiddlewares/routerRateLimiter/index.js";
import { handleGenerateBillingRequest } from "@/internal/billing/v2/handlers/handleGenerateBillingRequest.js";
import { handlePreviewAttach } from "@/internal/billing/v2/handlers/handlePreviewAttach.js";
import { handleResolveBillingRequest } from "@/internal/billing/v2/handlers/handleResolveBillingRequest.js";
import { handleCancelV2 } from "@/internal/customers/cancel/handleCancelV2.js";
import { handleOpenCustomerPortalV2 } from "@/internal/customers/handlers/handleBillingPortal/handleOpenCustomerPortalV2.js";
import type { HonoEnv } from "../../honoUtils/HonoEnv.js";
import { handleLegacyApiCheckout } from "./checkout/handleLegacyApiCheckout.js";
import { handleAttachV2 } from "./v2/handlers/handleAttachV2.js";
import { handleMultiAttach } from "./v2/handlers/handleMultiAttach.js";
import { handleMultiUpdate } from "./v2/handlers/handleMultiUpdate.js";
import { handlePreviewMultiAttach } from "./v2/handlers/handlePreviewMultiAttach.js";
import { handlePreviewMultiUpdate } from "./v2/handlers/handlePreviewMultiUpdate.js";
import { handlePreviewUpdateSubscription } from "./v2/handlers/handlePreviewUpdateSubscription.js";
import { handleUpdateSubscription } from "./v2/handlers/handleUpdateSubscription.js";

export const billingRouter = new Hono<HonoEnv>();

billingRouter.post("/cancel", ...handleCancelV2);
billingRouter.post("/checkout", ...handleLegacyApiCheckout);

export const billingRpcRouter = new Hono<HonoEnv>();
billingRpcRouter.post("/billing.update", ...handleUpdateSubscription);
billingRpcRouter.post(
	"/billing.preview_update",
	...handlePreviewUpdateSubscription,
);
billingRpcRouter.post("/billing.attach", ...handleAttachV2);
billingRpcRouter.post("/billing.multi_attach", ...handleMultiAttach);
billingRpcRouter.post(
	"/billing.preview_multi_attach",
	...handlePreviewMultiAttach,
);
billingRpcRouter.post("/billing.multi_update", ...handleMultiUpdate);
billingRpcRouter.post(
	"/billing.preview_multi_update",
	...handlePreviewMultiUpdate,
);
billingRpcRouter.post("/billing.preview_attach", ...handlePreviewAttach);
billingRpcRouter.post(
	"/billing.resolve_request",
	...handleResolveBillingRequest,
);

const generateBillingRequestLimiter = createRouterRateLimiter({
	keyPrefix: "billing_generate_request",
	limit: 10,
	windowMs: 10_000,
});
billingRpcRouter.post(
	"/agent.generate_billing_request",
	generateBillingRequestLimiter,
	...handleGenerateBillingRequest,
);
billingRpcRouter.post(
	"/billing.open_customer_portal",
	...handleOpenCustomerPortalV2,
);
