// billing/server/src/internal/inference/handlers/handleProvisionKey.ts
//
// POST /v1/keys
//
// Mint the gateway credential for one end user.
//
// The SDK calls this the first time it talks to a customer and caches the
// key, so the merchant's app never handles the MeterPal secret key on the
// hot path and the gateway only ever sees per-customer keys.

import { getBearerToken } from "@autumn/auth";
import { ErrCode, RecaseError } from "@autumn/shared";
import type { Context } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { resolveInferenceCaller } from "../inferenceAuth.js";
import {
	CustomerNotFoundForInference,
	findInferenceCustomer,
	getOrProvisionVirtualKey,
} from "../inferenceService.js";

export const handleProvisionKey = async (c: Context<HonoEnv>) => {
	const ctx = c.get("ctx");

	const token = getBearerToken({ headers: c.req.raw.headers });
	if (!token) {
		throw new RecaseError({
			message: "Secret key not found in Authorization header",
			code: ErrCode.NoSecretKey,
			statusCode: 401,
		});
	}

	// Only the merchant's own secret key may mint keys.
	const caller = await resolveInferenceCaller({ ctx, token });
	if (caller.credential !== "secret_key") {
		throw new RecaseError({
			message:
				"A virtual key cannot mint another key. Use the merchant's secret key.",
			code: ErrCode.InvalidSecretKey,
			statusCode: 401,
		});
	}

	const body = await c.req
		.json<{ customer_id?: string }>()
		.catch(() => null);
	const customerId = body?.customer_id;
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

	const key = await getOrProvisionVirtualKey({ ctx, customer });
	return c.json({
		key,
		customer_id: customer.id,
		created: !customer.litellm_virtual_key,
	});
};
