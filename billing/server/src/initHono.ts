import { ssoProvider } from "@autumn/shared";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db/initDrizzle.js";
import { autumnWebhookRouter } from "./external/autumn/autumnWebhookRouter.js";
import { paypalWebhookRouter } from "./external/paypal/webhookRouter.js";
import { baseMiddleware } from "./honoMiddlewares/baseMiddleware.js";
import { errorMiddleware } from "./honoMiddlewares/errorMiddleware.js";
import { inFlightTrackingMiddleware } from "./honoMiddlewares/inFlightTrackingMiddleware.js";
import { replicaDbMiddleware } from "./honoMiddlewares/replicaDbMiddleware.js";
import type { HonoEnv } from "./honoUtils/HonoEnv.js";
import { handleHealthCheck } from "./honoUtils/handleHealthCheck.js";
import { handleReadyCheck } from "./honoUtils/handleReadyCheck.js";
import { handleCapyLogin } from "./internal/auth/handleCapyLogin.js";
import { handleListAuthOrganizations } from "./internal/auth/handleListAuthOrganizations.js";
import { oauthRouter } from "./internal/auth/oauth/oauthRouter.js";
import { withTrustedSsoOrigin } from "./internal/auth/sso/ssoTrustedOrigins.js";
import { cliRouter } from "./internal/dev/cli/cliRouter.js";
import { inferenceRouter } from "./internal/inference/inferenceRouter.js";
import { slackUnfurlRouter } from "./internal/slackUnfurl/slackUnfurlRouter.js";
import { apiRouter } from "./routers/apiRouter.js";
import { createChatProxyRouter } from "./routers/chatProxyRouter.js";
import { internalRouter } from "./routers/internalRouter.js";
import { publicRouter } from "./routers/publicRouter.js";
import { auth, isCapyDev } from "./utils/auth.js";
import { isAllowedOrigin } from "./utils/corsOrigins.js";

const ALLOWED_HEADERS = [
	"app_env",
	"x-sandbox-org-id",
	"x-api-version",
	"x-client-type",
	"x-request-id",
	"x-visitor-id",
	"Authorization",
	"Content-Type",
	"Accept",
	"Origin",
	"X-API-Version",
	"X-Requested-With",
	"Access-Control-Request-Method",
	"Access-Control-Request-Headers",
	"Cache-Control",
	"If-Match",
	"If-None-Match",
	"If-Modified-Since",
	"If-Unmodified-Since",
	"idempotency-key",
	"Idempotency-Key",
	"User-Agent", // Required for better-auth v1.4.0+ compatibility with Safari/Zen browser
];

const FACADE_ONLY_SSO_PATHS = new Set([
	"/api/auth/sign-in/sso",
	"/api/auth/sso/register",
	"/api/auth/sso/request-domain-verification",
	"/api/auth/sso/verify-domain",
	"/api/auth/sso/providers",
	"/api/auth/sso/get-provider",
	"/api/auth/sso/update-provider",
	"/api/auth/sso/delete-provider",
]);

export const createHonoApp = () => {
	const app = new Hono<HonoEnv>();

	app.route("", createChatProxyRouter());

	// CORS configuration (must be before routes)
	app.use(
		"*",
		cors({
			origin: isAllowedOrigin,
			allowHeaders: ALLOWED_HEADERS,
			allowMethods: ["POST", "GET", "PUT", "DELETE", "PATCH", "OPTIONS"],
			exposeHeaders: ["Content-Length"],
			maxAge: 600,
			credentials: true,
		}),
	);

	app.route("", oauthRouter);

	// Better Auth's joined Drizzle query defaults to 100 memberships.
	app.get("/api/auth/organization/list", handleListAuthOrganizations);
	if (isCapyDev) {
		console.warn(
			"⚠️  CAPY_DEV=1 — the unauthenticated dev login GET /api/auth/capy-login is ENABLED. " +
				"Never run this outside local development.",
		);
		app.get("/api/auth/capy-login", handleCapyLogin);
	}

	app.on(["POST", "GET"], ["/api/auth/*"], async (c) => {
		if (FACADE_ONLY_SSO_PATHS.has(c.req.path)) {
			return c.json({ message: "Use the MeterPal SSO flow" }, 404);
		}
		const callbackMatch = c.req.path.match(
			/^\/api\/auth\/sso\/callback\/([^/]+)$/,
		);
		if (callbackMatch?.[1]) {
			const providerId = decodeURIComponent(callbackMatch[1]);
			const provider = await db.query.ssoProvider.findFirst({
				where: eq(ssoProvider.providerId, providerId),
			});
			if (!provider) {
				return c.json({ message: "SSO provider not found" }, 404);
			}
			return withTrustedSsoOrigin({
				origin: new URL(provider.issuer).origin,
				run: () => auth.handler(c.req.raw),
			});
		}
		return auth.handler(c.req.raw);
	});

	// OAuth callback (needs to be before middleware)
	// Health check endpoint for AWS/ECS load balancer

	app.get("/ready/:token", handleReadyCheck);
	app.get("/", handleHealthCheck);

	// Slack-unfurl (/slack-unfurl/*) — own prefix so it doesn't collide with the
	// chat proxy's /slack/* (-> leaf). Slack-facing, auths via request signature,
	// so mounted ahead of the org/auth middleware.
	app.route("/slack-unfurl", slackUnfurlRouter);

	// Step 1: OTel HTTP span + base middleware + span enrichment
	app.use(
		"*",
		httpInstrumentationMiddleware({
			serviceName: "autumn-server",
			serviceVersion: "1.0.0",
		}),
	);
	app.use("*", inFlightTrackingMiddleware);
	app.use("*", baseMiddleware);
	app.use("*", replicaDbMiddleware);

	// CLI routes (uses Bearer token auth, not session auth)
	app.route("/cli", cliRouter);

	// Add Render region identifier header for load balancer verification
	app.use("*", async (c, next) => {
		await next();
		c.header("x-region", process.env.AWS_REGION);
	});

	// Webhook routes
	app.route("", paypalWebhookRouter);
	app.route("/webhooks/autumn", autumnWebhookRouter);

	// Public routes (no auth required)
	app.route("", publicRouter);
	// Debug routes (no auth, dev-only guard is inside the handler)
	// Debug routes (auth handled internally)
	// app.route("/debug", heapSnapshotRouter);
	// app.route("/v1/debug", debugRouter);

	// API Middleware
	// The inference API authenticates itself (it accepts a merchant secret
	// key OR a per-customer virtual key), so it is mounted ahead of the
	// standard secret-key chain rather than inside it.
	app.route("/v1", inferenceRouter);
	app.route("/v1", apiRouter);

	// [REWARDS DISABLED] The rewards/referral routers are unmounted (see
	// routers/apiRouter.ts and routers/rpcRouter.ts). Answer 404 here rather
	// than fall through to internalRouter's session gate below, which would
	// return a misleading 401. Patterns are segment-safe (full-segment
	// wildcards or exact dotted RPC names) so they match under every Hono
	// router. Remove with the router markers to re-enable.
	const rewardsDisabledHandler = (c: Context<HonoEnv>) =>
		c.json({ error: "not_found" }, 404);
	const rewardsDisabledPaths = [
		"/v1/rewards",
		"/v1/rewards/*",
		"/v1/rewards.list",
		"/v1/rewards.create",
		"/v1/rewards.get",
		"/v1/rewards.update",
		"/v1/rewards.delete",
		"/v1/rewards.redeem",
		"/v1/reward_programs",
		"/v1/reward_programs/*",
		"/v1/reward_programs.create",
		"/v1/reward_programs.list",
		"/v1/reward_programs.get",
		"/v1/reward_programs.update",
		"/v1/reward_programs.delete",
		"/v1/referrals",
		"/v1/referrals/*",
		"/v1/referrals.create_code",
		"/v1/referrals.redeem_code",
		"/v1/referral_programs.create",
		"/v1/referral_programs.list",
		"/v1/referral_programs.get",
		"/v1/referral_programs.update",
		"/v1/referral_programs.delete",
		"/v1/redemptions",
		"/v1/redemptions/*",
	];
	for (const path of rewardsDisabledPaths) {
		app.all(path, rewardsDisabledHandler);
	}

	// OAuth/MCP discovery is public by contract, so an unmatched probe must 404
	// here rather than fall through to internalRouter's session gate below,
	// which answers with a misleading 401. Everything this server does serve is
	// registered on oauthRouter and the chat proxy, both mounted well above.
	app.all("/.well-known/*", (c) => c.json({ error: "not_found" }, 404));

	app.route("", internalRouter);

	app.onError(errorMiddleware);

	return app;
};
