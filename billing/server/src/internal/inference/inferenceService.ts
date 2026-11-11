// billing/server/src/internal/inference/inferenceService.ts
//
// The MeterPal inference proxy.
//
// A merchant's app calls one OpenAI-shaped endpoint.  This service resolves
// who is calling, which model they may call, which end user is being
// billed, and which virtual key the gateway should see -- then it forwards
// the call to the shared gateway and reports what it cost.
//
// The gateway's bridge stays the single metering authority: the proxy never
// debits anything itself.  It only links the response back to the charge
// the bridge writes, through the LiteLLM call id.

import {
	AppEnv,
	customers,
	type DbCustomer,
	RecaseError,
} from "@autumn/shared";
import { and, eq, or } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { litellmBase, litellmFeatureId } from "@/internal/keys/litellmEnv.js";
import {
	provisionLitellmKey,
	resolveCustomerPlanKey,
} from "@/internal/keys/litellmKeys.js";
import {
	decryptVirtualKey,
	encryptVirtualKey,
} from "@/internal/keys/virtualKeyCrypto.js";
import {
	getServedModel,
	getServedModelAllowList,
	resolveServedModelId,
} from "@/internal/models/servedModelService.js";
import type { InferenceCaller } from "./inferenceAuth.js";
import {
	CustomerMismatchError,
	GatewayError,
	MissingCustomerError,
	ModelNotEnabledError,
	ModelNotFoundError,
} from "./inferenceErrors.js";
import { readWallet } from "@/internal/balances/walletProjection.js";
import { waitForSettledUsage } from "./usageSettlement.js";

/** The OpenAI-shaped request body. Extra fields are passed through. */
export type InferenceRequest = {
	model: string;
	messages?: unknown[];
	user?: string;
	stream?: boolean;
	[key: string]: unknown;
};

/** The block MeterPal adds to every response. */
export type MeterpalBlock = {
	/** Credits the call cost. Null when the usage event never landed. */
	credits_charged: number | null;
	/** The end user's balance after the call. */
	balance_after: number | null;
	customer_id: string;
	/** The model id the charge was recorded against. */
	model_id: string | null;
	/**
	 * Prompt tokens as the provider counted them — cached input INCLUDED.
	 *
	 * This is the count the charge was computed from, so
	 * `input_tokens * input_rate + output_tokens * output_rate` reproduces
	 * `credits_charged`.  Reporting only the uncached remainder (which is
	 * what the ledger stores per pool) made a correct charge look wrong on
	 * screen: 40 in / 475 out priced at $200/$800 is $0.388, but a call
	 * with 256 cached tokens costs $0.4608.
	 */
	input_tokens: number | null;
	/** Completion tokens as the provider counted them — reasoning INCLUDED. */
	output_tokens: number | null;
	/** The part of `input_tokens` the provider served from its prompt cache. */
	cache_read_tokens: number | null;
	/** The part of `input_tokens` written to the provider's prompt cache. */
	cache_write_tokens: number | null;
	/** The part of `output_tokens` the model spent reasoning. */
	reasoning_tokens: number | null;
};

export type ResolvedModel = {
	/** The name the gateway knows the model by. */
	upstreamModel: string;
	/** The id the merchant bills it as. */
	billableModelId: string;
};

/**
 * Which model may this org call, and what does it bill it as?
 *
 * An org with no price sheet serves everything the gateway offers -- that
 * is the pre-P2 behaviour and it keeps an org that never opened the Models
 * tab working.  Once the org has rows, the enabled ones are the allow-list
 * and a disabled model is refused rather than silently priced.
 */
export const resolveInferenceModel = async ({
	ctx,
	model,
}: {
	ctx: AutumnContext;
	model: string;
}): Promise<ResolvedModel> => {
	const { db, org, env } = ctx;

	const allowList = await getServedModelAllowList({
		db,
		orgId: org.id,
		env,
	});

	if (allowList !== null && !allowList.includes(model)) {
		// The gateway hands us the name IT knows the model by ("agnes-flash"),
		// while the org's sheet lists the id it bills ("custom/agnes-2.5-flash")
		// and records the gateway's name as `upstream_model`.  Resolve through
		// that mapping before declaring the model unserved — otherwise every
		// aliased model 404s even though the merchant sells it.
		const resolvedId = await resolveServedModelId({
			db,
			orgId: org.id,
			env,
			modelId: model,
		});
		if (resolvedId) {
			// It resolves to a row; it must be enabled to be callable.
			if (!allowList.includes(resolvedId)) {
				throw new ModelNotEnabledError({ model });
			}
			const resolvedRow = await getServedModel({
				db,
				orgId: org.id,
				env,
				modelId: resolvedId,
			});
			return {
				upstreamModel: resolvedRow?.upstream_model ?? model,
				billableModelId: resolvedId,
			};
		}

		const row = await getServedModel({ db, orgId: org.id, env, modelId: model });
		// The model is in the sheet but switched off, or not in it at all.
		if (row) throw new ModelNotEnabledError({ model });
		throw new ModelNotFoundError({ model });
	}

	const row = await getServedModel({ db, orgId: org.id, env, modelId: model });
	return {
		upstreamModel: row?.upstream_model ?? model,
		billableModelId: row?.model_id ?? model,
	};
};

/**
 * The end user being billed.
 *
 * A virtual key names its own customer and may not bill anyone else.  A
 * secret key bills whoever the request names -- but only a customer of that
 * org, which is what stops one merchant from billing another's user.
 */
export const resolveInferenceCustomer = async ({
	ctx,
	caller,
	body,
}: {
	ctx: AutumnContext;
	caller: InferenceCaller;
	body: InferenceRequest;
}): Promise<DbCustomer & { id: string }> => {
	const requestedUser = typeof body.user === "string" ? body.user : undefined;

	if (caller.credential === "virtual_key") {
		if (requestedUser && requestedUser !== caller.customerId) {
			throw new CustomerMismatchError({
				expected: caller.customerId as string,
				received: requestedUser,
			});
		}
	} else if (!requestedUser) {
		throw new MissingCustomerError();
	}

	const customerId = requestedUser ?? (caller.customerId as string);
	const customer = await findInferenceCustomer({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		idOrInternalId: customerId,
	});
	if (!customer) {
		throw new CustomerNotFoundForInference(customerId);
	}

	return customer;
};

/**
 * A customer of this org, by external or internal id.
 *
 * Reads the row directly rather than through the public customer shape: the
 * virtual key is not part of the customer API contract, so it must not
 * appear in a customer response.
 */
export const findInferenceCustomer = async ({
	db,
	orgId,
	env,
	idOrInternalId,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
	idOrInternalId: string;
}): Promise<(DbCustomer & { id: string }) | null> => {
	const row = await db.query.customers.findFirst({
		where: and(
			or(
				eq(customers.id, idOrInternalId),
				eq(customers.internal_id, idOrInternalId),
			),
			eq(customers.org_id, orgId),
			eq(customers.env, env),
		),
	});
	// A customer without an external id cannot be billed: the id is what the
	// gateway and the usage ledger are keyed on.
	if (!row?.id) return null;
	return row as DbCustomer & { id: string };
};

/**
 * The gateway credential for this customer.
 *
 * The key is per-customer, so the gateway can tell the tenants apart and a
 * customer can never spend another customer's budget.  It is minted on the
 * first call and reused afterwards; a customer that already has one keeps
 * it, with the budget its plan gave it.
 */
export const getOrProvisionVirtualKey = async ({
	ctx,
	customer,
}: {
	ctx: AutumnContext;
	customer: DbCustomer;
}): Promise<string> => {
	// The stored value is encrypted at rest — hand back the live key.
	// A legacy plaintext row is upgraded in place on this touch, so existing
	// keys stop sitting in the clear as soon as their owner calls in.
	const stored = customer.litellm_virtual_key;
	const existingKey = decryptVirtualKey(stored);
	if (existingKey) {
		if (stored?.startsWith("sk-")) {
			await ctx.db
				.update(customers)
				.set({ litellm_virtual_key: encryptVirtualKey(existingKey) })
				.where(eq(customers.id, customer.id as string));
		}
		return existingKey;
	}

	const planKey = await resolveCustomerPlanKey({ ctx, customer });
	const provisioned = await provisionLitellmKey(ctx, {
		customerId: customer.id as string,
		planKey,
	});
	if (!provisioned?.key) {
		throw new GatewayError({
			message: `Could not provision an inference key for customer ${customer.id}`,
			statusCode: 502,
		});
	}
	return provisioned.key;
};

/** The body forwarded to the gateway. */
export const buildGatewayPayload = ({
	body,
	resolvedModel,
	customerId,
}: {
	body: InferenceRequest;
	resolvedModel: ResolvedModel;
	customerId: string;
}): Record<string, unknown> => {
	const payload: Record<string, unknown> = {
		...body,
		model: resolvedModel.upstreamModel,
		// The bridge reads the customer from here.
		user: customerId,
	};

	if (body.stream) {
		// Ask for the usage chunk so a streaming client still learns what the
		// call cost.
		payload.stream_options = {
			include_usage: true,
			...(body.stream_options as Record<string, unknown> | undefined),
		};
	}

	return payload;
};

/** Forward the call to the shared gateway. */
export const callGateway = async ({
	virtualKey,
	callId,
	payload,
	signal,
}: {
	virtualKey: string;
	callId: string;
	payload: Record<string, unknown>;
	signal?: AbortSignal;
}): Promise<Response> => {
	return await fetch(`${litellmBase()}/v1/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${virtualKey}`,
			"Content-Type": "application/json",
			// The bridge uses this as the idempotency key of the settle call,
			// which is how the response is linked back to its charge.
			"x-litellm-call-id": callId,
		},
		body: JSON.stringify(payload),
		...(signal ? { signal } : {}),
	});
};

/** Wait for the charge the bridge recorded, and describe it. */
export const settleMeterpalBlock = async ({
	ctx,
	customer,
	callId,
}: {
	ctx: AutumnContext;
	customer: DbCustomer;
	callId: string;
}): Promise<MeterpalBlock> => {
	const settled = await waitForSettledUsage({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		customerId: customer.id as string,
		callId,
	});

	if (!settled) {
		// No charge event landed (the bridge is fail-open).  Report the
		// settled wallet rather than the raw balance, which may still have
		// this call's reservation deducted from it.
		const wallet = await readWallet({
			db: ctx.db,
			orgId: ctx.org.id,
			env: ctx.env,
			customerId: customer.id as string,
			featureId: litellmFeatureId(),
		});
		return {
			credits_charged: null,
			balance_after: wallet.settled,
			customer_id: customer.id as string,
			model_id: null,
			input_tokens: null,
			output_tokens: null,
			cache_read_tokens: null,
			cache_write_tokens: null,
			reasoning_tokens: null,
		};
	}

	// The event stores the bill as pools: uncached input, cache reads, cache
	// writes, non-reasoning output, reasoning.  The block reports the totals
	// the pools add up to, so the number beside the charge is the number the
	// charge was computed from -- and the split stays available for anyone
	// who wants to see where it went.
	const cacheRead = settled.cacheReadTokens ?? 0;
	const cacheWrite = settled.cacheWriteTokens ?? 0;
	const reasoning = settled.reasoningTokens ?? 0;

	return {
		credits_charged: settled.creditsCharged,
		balance_after: settled.balanceAfter,
		customer_id: customer.id as string,
		model_id: settled.modelId,
		input_tokens:
			settled.inputTokens === null
				? null
				: settled.inputTokens + cacheRead + cacheWrite,
		output_tokens:
			settled.outputTokens === null
				? null
				: settled.outputTokens + reasoning,
		cache_read_tokens: settled.cacheReadTokens,
		cache_write_tokens: settled.cacheWriteTokens,
		reasoning_tokens: settled.reasoningTokens,
	};
};

/**
 * A customer the org does not have.
 *
 * Its own error class (rather than the shared one) so the message tells the
 * caller what to do about it: create the end user, then call again.
 */
export class CustomerNotFoundForInference extends RecaseError {
	constructor(customerId: string) {
		super({
			message: `No customer ${customerId} in this organization. Create the end user before calling inference.`,
			code: "customer_not_found",
			statusCode: 404,
		});
		this.name = "CustomerNotFoundForInference";
	}
}
