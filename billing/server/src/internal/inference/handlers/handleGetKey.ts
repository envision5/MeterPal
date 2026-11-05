// billing/server/src/internal/inference/handlers/handleGetKey.ts
//
// GET /v1/keys/:customer_id
//
// The gateway key for one end user, if it has been minted.
//
// Read-only on purpose: minting happens on POST /v1/keys.  A GET never
// creates a credential behind the caller's back.

import { getBearerToken } from "@autumn/auth";
import { ErrCode, RecaseError } from "@autumn/shared";
import type { Context } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { decryptVirtualKey } from "@/internal/keys/virtualKeyCrypto.js";
import { resolveInferenceCaller } from "../inferenceAuth.js";
import {
	CustomerNotFoundForInference,
	findInferenceCustomer,
} from "../inferenceService.js";

export const handleGetKey = async (c: Context<HonoEnv>) => {
	const ctx = c.get("ctx");

	const token = getBearerToken({ headers: c.req.raw.headers });
	if (!token) {
		throw new RecaseError({
			message: "Secret key not found in Authorization header",
			code: ErrCode.NoSecretKey,
			statusCode: 401,
		});
	}

	const caller = await resolveInferenceCaller({ ctx, token });
	if (caller.credential !== "secret_key") {
		throw new RecaseError({
			message:
				"A virtual key cannot read another customer's key. Use the merchant's secret key.",
			code: ErrCode.InvalidSecretKey,
			statusCode: 401,
		});
	}

	const customerId = c.req.param("customer_id");
	if (!customerId) {
		throw new RecaseError({
			message: "`customer_id` is required",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	const customer = await findInferenceCustomer({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		idOrInternalId: customerId,
	});
	if (!customer) throw new CustomerNotFoundForInference(customerId);

	// The stored value is encrypted at rest; the merchant's secret-key
	// caller gets the live key back.
	const liveKey = decryptVirtualKey(customer.litellm_virtual_key);
	return c.json({
		customer_id: customer.id,
		key: liveKey,
		provisioned: Boolean(customer.litellm_virtual_key),
	});
};
