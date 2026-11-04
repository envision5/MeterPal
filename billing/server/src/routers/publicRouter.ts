import { Hono } from "hono";
import { publicSsoRouter } from "@/internal/auth/sso/publicSsoRouter.js";
import { portalRouter } from "@/internal/billing/portal/portalRouter.js";
import { publicCheckoutRouter } from "@/internal/checkouts/checkoutRouter.js";
import { publicTrmnlRouter } from "@/internal/misc/trmnl/trmnlRouter.js";
import { agentOnboardingRouter } from "@/internal/orgs/agentOnboarding/agentOnboardingRouter.js";
import type { HonoEnv } from "../honoUtils/HonoEnv.js";
import { paypalReturnRouter } from "@/internal/billing/paypal/paypalReturnRouter.js";
import { publicInvoiceRouter } from "../internal/invoices/invoiceRouter.js";

export const publicRouter = new Hono<HonoEnv>();
publicRouter.route("", agentOnboardingRouter);
publicRouter.route("/checkouts", publicCheckoutRouter);
publicRouter.route("/paypal", paypalReturnRouter);
publicRouter.route("/invoices", publicInvoiceRouter);
publicRouter.route("/portal", portalRouter);
publicRouter.route("/trmnl", publicTrmnlRouter);
publicRouter.route("/auth/sso", publicSsoRouter);
