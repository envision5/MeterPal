import { user as userTable } from "@autumn/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { organizationSsoRouter } from "@/internal/auth/sso/ssoRouter.js";
import { setupRouter } from "@/internal/setup/setupRouter.js";
import { handleDeleteOrg } from "./handlers/crudHandlers/handleDeleteOrg.js";
import { handleGetOrg } from "./handlers/crudHandlers/handleGetOrg.js";
import {
	handleGetCustomButtons,
	handleUpdateCustomButtons,
} from "./handlers/handleCustomButtons.js";
import { handleDeleteOrgLogo } from "./handlers/handleDeleteOrgLogo.js";
import { handleFetchOrgLogo } from "./handlers/handleFetchOrgLogo.js";
import { handleGetOnboardingStatus } from "./handlers/handleGetOnboardingStatus.js";
import { handleGetOrgFlags } from "./handlers/handleGetOrgFlags.js";
import { handleGetUploadUrl } from "./handlers/handleGetUploadUrl.js";
import {
	handleDeleteRedisConfig,
	handleUpdateRedisMigration,
	handleUpsertRedisConfig,
} from "./handlers/handleRedisConfig.js";
import {
	handleGetTransitionRules,
	handleUpdateTransitionRules,
} from "./handlers/handleTransitionRules.js";
import { handleUpdateOrg } from "./handlers/handleUpdateOrg.js";
import { handleUpdateOrgConfig } from "./handlers/handleUpdateOrgConfig.js";
import { handleGetInvites } from "./handlers/memberHandlers/handleGetInvites.js";
import { handleGetOrgMembers } from "./handlers/memberHandlers/handleGetOrgMembers.js";
import { handleRemoveMember } from "./handlers/memberHandlers/handleRemoveMember.js";
import { handleConnectPaypal } from "./handlers/paypalHandlers/handleConnectPaypal.js";
import { handleDeletePaypal } from "./handlers/paypalHandlers/handleDeletePaypal.js";
import { handleGetPaypalConfig } from "./handlers/paypalHandlers/handleGetPaypalConfig.js";
import { handleGetAgentConfig } from "./handlers/handleGetAgentConfig.js";
import { handleUpdateAgentConfig } from "./handlers/handleUpdateAgentConfig.js";

export const internalOrgRouter = new Hono<HonoEnv>();

internalOrgRouter.get("", ...handleGetOrg);
internalOrgRouter.delete("", ...handleDeleteOrg);
internalOrgRouter.patch("/config", ...handleUpdateOrgConfig);
internalOrgRouter.get("/custom-buttons", ...handleGetCustomButtons);
internalOrgRouter.patch("/custom-buttons", ...handleUpdateCustomButtons);
internalOrgRouter.get("/agent-config", ...handleGetAgentConfig);
internalOrgRouter.patch("/agent-config", ...handleUpdateAgentConfig);
internalOrgRouter.get("/transition_rules", ...handleGetTransitionRules);
internalOrgRouter.patch("/transition_rules", ...handleUpdateTransitionRules);
internalOrgRouter.get("/members", ...handleGetOrgMembers);
internalOrgRouter.post("/remove-member", ...handleRemoveMember);
internalOrgRouter.get("/upload_url", ...handleGetUploadUrl);
internalOrgRouter.delete("/logo", ...handleDeleteOrgLogo);
internalOrgRouter.post("/logo/fetch", ...handleFetchOrgLogo);
internalOrgRouter.get("/invites", ...handleGetInvites);
// Mounted under /organization, so this resolves to
// POST /organization/onboardingStatus.
internalOrgRouter.post("/onboardingStatus", ...handleGetOnboardingStatus);
// The onboarding wizard's state and its two actions.
internalOrgRouter.route("/setup", setupRouter);
internalOrgRouter.route("/sso", organizationSsoRouter);

export const honoOrgRouter = new Hono<HonoEnv>();
honoOrgRouter.get("", ...handleGetOrg);
honoOrgRouter.get("/flags", ...handleGetOrgFlags);
honoOrgRouter.get("/me", async (c) => {
	const { db, org, env, user, userId } = c.get("ctx");
	const authUser =
		user ??
		(userId
			? await db.query.user.findFirst({
					where: eq(userTable.id, userId),
				})
			: undefined);
	return c.json({
		id: org.id,
		name: org.name,
		slug: org.slug,
		env,
		// A sandbox's key answers as the sandbox; the CLI needs to tell that
		// apart from the main organization's key.
		is_sandbox: org.is_sandbox === true,
		created_by: org.created_by ?? null,
		// A keyless org is pending until someone claims it; the CLI offers the
		// link while the window is open.
		claim_state: org.claim_state ?? null,
		// A cached org carries the timestamp as a string, a fresh row as a Date.
		claim_expires_at: org.claim_expires_at
			? new Date(org.claim_expires_at).toISOString()
			: null,
		user: authUser
			? {
					id: authUser.id,
					email: authUser.email,
					name: authUser.name,
				}
			: undefined,
	});
});
honoOrgRouter.patch("", ...handleUpdateOrg);
honoOrgRouter.patch("/config", ...handleUpdateOrgConfig);
honoOrgRouter.get("/custom-buttons", ...handleGetCustomButtons);
honoOrgRouter.patch("/custom-buttons", ...handleUpdateCustomButtons);
honoOrgRouter.get("/transition_rules", ...handleGetTransitionRules);
honoOrgRouter.patch("/transition_rules", ...handleUpdateTransitionRules);

// PayPal: the org's own PayPal account, per environment.
honoOrgRouter.get("/paypal", ...handleGetPaypalConfig);
honoOrgRouter.post("/paypal", ...handleConnectPaypal);
honoOrgRouter.delete("/paypal", ...handleDeletePaypal);

honoOrgRouter.patch("/redis", ...handleUpsertRedisConfig);
honoOrgRouter.delete("/redis", ...handleDeleteRedisConfig);
honoOrgRouter.patch("/redis/migration", ...handleUpdateRedisMigration);
