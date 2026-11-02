// billing/server/src/internal/inference/inferenceAuth.ts
//
// Who is calling the inference proxy.
//
// Two credentials are accepted:
//
//   am_sk_...  the merchant's MeterPal secret key.  The org comes from the
//              key; the end user comes from the request's `user` field.
//   sk-...     a customer virtual key issued by MeterPal (POST /v1/keys).
//              The org AND the end user come from the key, so a leaked
//              per-customer key can neither reach another tenant nor bill
//              a different end user.
//
// Both paths end with the same context as every other /v1 route: org, env,
// features and scopes.

import { isSecretKeyPrefix } from "@autumn/auth";
import {
	AppEnv,
	AuthType,
	customers,
	ErrCode,
	type Feature,
	type Organization,
	RecaseError,
	sortFeatures,
} from "@autumn/shared";
import { eq } from "drizzle-orm";
import { verifyKey } from "@/internal/dev/apiKeys/actions/verifyKey.js";
import { getOrgWithFeaturesCached } from "@/internal/orgs/orgUtils/getOrgWithFeaturesCached.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";

export type InferenceCredential = "secret_key" | "virtual_key";

export type InferenceCaller = {
	org: Organization;
	env: AppEnv;
	features: Feature[];
	credential: InferenceCredential;
	/** The customer the virtual key belongs to. Null for a secret key. */
	customerId: string | null;
};

/** LiteLLM issues virtual keys with this prefix. */
export const VIRTUAL_KEY_PREFIX = "sk-";

const invalidCredential = (message: string) =>
	new RecaseError({
		message,
		code: ErrCode.InvalidSecretKey,
		statusCode: 401,
	});

export const resolveInferenceCaller = async ({
	ctx,
	token,
}: {
	ctx: AutumnContext;
	token: string;
}): Promise<InferenceCaller> => {
	if (isSecretKeyPrefix({ token })) {
		const data = await verifyKey({ db: ctx.db, key: token, requestId: ctx.id });
		if (!data) throw invalidCredential("Invalid secret key");

		sortFeatures({ features: data.features });

		ctx.org = data.org;
		ctx.env = data.env;
		ctx.features = data.features;
		ctx.scopes = data.scopes ?? [];
		ctx.authType = AuthType.SecretKey;

		return {
			org: data.org,
			env: data.env,
			features: data.features,
			credential: "secret_key",
			customerId: null,
		};
	}

	if (token.startsWith(VIRTUAL_KEY_PREFIX)) {
		const customer = await ctx.db.query.customers.findFirst({
			where: eq(customers.litellm_virtual_key, token),
		});
		if (!customer) throw invalidCredential("Invalid virtual key");

		const env = customer.env as AppEnv;
		const orgData = await getOrgWithFeaturesCached({
			db: ctx.db,
			orgId: customer.org_id,
			env,
		});
		if (!orgData) {
			throw invalidCredential("Invalid virtual key");
		}
		const { org, features } = orgData;

		sortFeatures({ features });

		ctx.org = org;
		ctx.env = env;
		ctx.features = features;
		ctx.scopes = [];
		ctx.authType = AuthType.SecretKey;
		ctx.customerId = customer.id ?? undefined;

		return {
			org,
			env,
			features,
			credential: "virtual_key",
			customerId: customer.id ?? null,
		};
	}

	throw invalidCredential("Invalid authorization token prefix");
};
