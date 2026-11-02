// billing/server/src/honoMiddlewares/gatewayAuthMiddleware.ts
//
// Authenticating the hosted gateway.
//
// The gateway is MeterPal's own infrastructure and it serves every merchant
// from one deployment.  It cannot present a merchant's secret key when it
// bills a different merchant, so it presents a shared secret instead and
// names the tenant it resolved from the caller's virtual key.
//
// The tenant is trusted because of what the gateway had to do to produce it:
// a virtual key is minted by this server, carries `<org>:<customer>` in its
// identity, and only the master key can create one.  A merchant's app holds
// a virtual key for its own customer and cannot name another org's.
//
// Everything downstream then works exactly as it does for a secret key: the
// org, env and features are loaded, and the customer is looked up inside
// that org, so a request that names a customer of another org is refused
// rather than billed.

import { AppEnv, AuthType, ErrCode, RecaseError, sortFeatures } from "@autumn/shared";
import type { Context, Next } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { gatewayTrustSecret } from "@/internal/keys/litellmEnv.js";
import { getOrgWithFeaturesCached } from "@/internal/orgs/orgUtils/getOrgWithFeaturesCached.js";

/** Is this the shared gateway secret? */
export const isGatewayCredential = (token: string): boolean => {
	const secret = gatewayTrustSecret();
	return secret.length > 0 && token === secret;
};

export const gatewayAuthMiddleware = async (
	c: Context<HonoEnv>,
	next: Next,
) => {
	const ctx = c.get("ctx");

	// The gateway names the tenant it resolved from the virtual key.
	const body = (await c.req.json().catch(() => null)) as {
		org_id?: string;
		env?: string;
	} | null;

	const orgId = body?.org_id;
	if (!orgId) {
		throw new RecaseError({
			message:
				"The gateway must name the tenant it resolved from the caller's key",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	const env = (body?.env ?? AppEnv.Sandbox) as AppEnv;
	const orgData = await getOrgWithFeaturesCached({
		db: ctx.db,
		orgId,
		env,
	});
	if (!orgData) {
		throw new RecaseError({
			message: `Unknown organization ${orgId}`,
			code: ErrCode.OrgNotFound,
			statusCode: 404,
		});
	}
	const { org, features } = orgData;

	sortFeatures({ features });

	ctx.org = org;
	ctx.features = features;
	ctx.env = env;
	ctx.authType = AuthType.Gateway;
	// The gateway is MeterPal's own infrastructure: it is not a merchant's
	// key, so it carries no scopes of its own.
	ctx.scopes = [];

	await next();
};
