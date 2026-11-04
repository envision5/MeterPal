// billing/server/src/internal/models/deploymentService.ts
//
// Dashboard-managed gateway deployments for a served model.
//
// A deployment is one instance of a model wired to a real provider account:
// a provider-prefixed model, an API key, an optional base URL, and optional
// rate ceilings.  A merchant adds several of them -- each with its own key --
// and the gateway load-balances across the group, which is how a model's
// traffic spreads past one account's rate limit.
//
// This file is the boundary between the two systems.  MeterPal owns the
// merchant's view (which instances exist, which key is which); the gateway
// owns the routing.  Every write here is pushed through to the gateway
// FIRST: a deployment exists in this database only once the gateway has
// accepted it, so the dashboard never shows an instance that cannot serve.
//
// The gateway is shared by every org, so a model's deployments are
// registered under a per-org, per-env name (gatewayDeploymentName).  Two
// merchants configuring "gpt-4o" must never share a router group -- they
// would route each other's calls to their own provider accounts.

import { and, asc, eq } from "drizzle-orm";
import {
	servedModelDeployments,
	servedModels,
	type ServedModelDeployment,
} from "@autumn/shared";
import { RecaseError } from "@autumn/shared";
import { ErrCode } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { litellmBase, litellmMasterKey } from "@/internal/keys/litellmEnv.js";
import { syncOrgLitellmKeys } from "@/internal/keys/litellmKeys.js";
import { decryptData, encryptData } from "@/utils/encryptUtils.js";
import { generateId } from "@/utils/genUtils.js";

/** Injectable transport, so tests can stub the gateway. */
export type FetchImpl = typeof fetch;

/**
 * Keys the dashboard owns as first-class fields, plus the ones that would
 * move pricing or billing away from the price sheet. `extra_params` may not
 * set them — a deployment would then have two values for the same knob, and
 * only one of them visible in the form.
 */
export const RESERVED_EXTRA_PARAMS: readonly string[] = [
	// First-class form fields (the deployment's own columns).
	"model",
	"api_key",
	"api_base",
	"rpm",
	"tpm",
	"timeout",
	"max_retries",
	"weight",
	"order",
	"organization",
	// The gateway's pricing mirror must stay informational: the price sheet
	// is the only authority on what a model costs.
	"input_cost_per_token",
	"output_cost_per_token",
	"input_cost_per_second",
	"output_cost_per_second",
	// LiteLLM-native billing on a shared gateway would bill nobody: the
	// bridge is the sole metering authority.
	"max_budget",
	"budget_duration",
];

export type ExtraParams = Record<string, unknown>;

/** Rejects reserved keys before anything is stored or pushed. */
export const validateExtraParams = (extraParams: ExtraParams): void => {
	const offenders = Object.keys(extraParams).filter((key) =>
		RESERVED_EXTRA_PARAMS.includes(key),
	);
	if (offenders.length > 0) {
		throw new RecaseError({
			message: `These params are configured elsewhere: ${offenders.join(", ")}. Set them on the instance fields instead${offenders.some((k) => k.startsWith("input_cost") || k.startsWith("output_cost")) ? " — the price sheet owns pricing" : ""}.`,
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}
};

/** The fields a caller can set on a deployment. `api_key` and `extra_params`
 *  are optional on update: absent means keep the stored value (neither is
 *  ever echoed back — both can hold provider secrets). */
export type DeploymentInput = {
	provider_model?: string;
	api_key?: string | null;
	api_base?: string | null;
	rpm?: number | null;
	tpm?: number | null;
	timeout?: number | null;
	max_retries?: number | null;
	weight?: number | null;
	/** LiteLLM's `order` — lower orders are tried first. */
	routing_order?: number | null;
	organization?: string | null;
	extra_params?: ExtraParams | null;
};

/**
 * The LiteLLM model name a model's deployment group is registered under.
 *
 * The sandbox and the live env name their own groups (`mp_sandbox_...` /
 * `mp_live_...`): they share one gateway process, and a sandbox instance and
 * a live instance of the same model must not end up in one router group.
 * The model id is sanitized to `[A-Za-z0-9_.-]` -- ids like
 * `openai/gpt-4o-mini` contain a slash, and the billing bridge resolves
 * names by the segment after the last one.
 */
export const gatewayDeploymentName = ({
	env,
	orgId,
	modelId,
}: {
	env: string;
	orgId: string;
	modelId: string;
}): string =>
	`mp_${env}_${orgId}__${modelId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;

/** Last four characters, for the dashboard's "which key is this" read. */
export const apiKeyHint = (apiKey: string): string => apiKey.slice(-4);

/**
 * Recovers the merchant's extra params for a re-push. The blob is encrypted
 * whole (credential families hold secrets), so a corrupt or missing one
 * reads as "none" rather than wedging the deployment.
 */
const parseExtraParams = (enc: string | null): ExtraParams => {
	if (!enc) return {};
	try {
		const parsed: unknown = JSON.parse(decryptData(enc));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as ExtraParams)
			: {};
	} catch {
		return {};
	}
};

const storeExtraParams = (extraParams: ExtraParams) => ({
	extra_params_enc:
		Object.keys(extraParams).length > 0
			? encryptData(JSON.stringify(extraParams))
			: null,
	extra_params_keys:
		Object.keys(extraParams).length > 0 ? Object.keys(extraParams) : null,
});

async function gatewayFetch(
	path: string,
	body: Record<string, unknown> | null,
	method: "GET" | "POST",
	fetchImpl: FetchImpl,
): Promise<{ status: number; body: any }> {
	const res = await fetchImpl(`${litellmBase()}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${litellmMasterKey()}`,
			"Content-Type": "application/json",
		},
		...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
	});
	const text = await res.text();
	let parsed: any = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = { raw: text };
	}
	return { status: res.status, body: parsed };
}

/**
 * The litellm_params for one deployment: the first-class fields, then the
 * merchant's extra params (already validated against the reserved set).
 * This is the only place litellm_params is assembled — create and update
 * both come through here, so the two paths cannot drift.
 */
export const buildLitellmParams = ({
	providerModel,
	apiKey,
	apiBase,
	rpm,
	tpm,
	timeout,
	maxRetries,
	weight,
	routingOrder,
	organization,
	extraParams,
}: {
	providerModel: string;
	apiKey: string;
	apiBase?: string | null;
	rpm?: number | null;
	tpm?: number | null;
	timeout?: number | null;
	maxRetries?: number | null;
	weight?: number | null;
	routingOrder?: number | null;
	organization?: string | null;
	extraParams?: ExtraParams | null;
}): Record<string, unknown> => {
	const params: Record<string, unknown> = {
		model: providerModel,
		api_key: apiKey,
	};
	if (apiBase) params.api_base = apiBase;
	if (rpm != null) params.rpm = Math.round(rpm);
	if (tpm != null) params.tpm = Math.round(tpm);
	if (timeout != null) params.timeout = timeout;
	if (maxRetries != null) params.max_retries = Math.round(maxRetries);
	if (weight != null) params.weight = Math.round(weight);
	if (routingOrder != null) params.order = Math.round(routingOrder);
	if (organization) params.organization = organization;
	if (extraParams) {
		for (const [key, value] of Object.entries(extraParams)) {
			params[key] = value;
		}
	}
	return params;
};

/**
 * Registers one deployment on the gateway and returns the LiteLLM model row
 * id to store in `gateway_model_id`.
 */
export const pushDeploymentToGateway = async ({
	modelName,
	providerModel,
	apiKey,
	apiBase,
	rpm,
	tpm,
	timeout,
	maxRetries,
	weight,
	routingOrder,
	organization,
	extraParams,
	fetchImpl = fetch,
}: {
	modelName: string;
	providerModel: string;
	apiKey: string;
	apiBase?: string | null;
	rpm?: number | null;
	tpm?: number | null;
	timeout?: number | null;
	maxRetries?: number | null;
	weight?: number | null;
	routingOrder?: number | null;
	organization?: string | null;
	extraParams?: ExtraParams | null;
	fetchImpl?: FetchImpl;
}): Promise<string | null> => {
	const litellmParams = buildLitellmParams({
		providerModel,
		apiKey,
		apiBase,
		rpm,
		tpm,
		timeout,
		maxRetries,
		weight,
		routingOrder,
		organization,
		extraParams,
	});

	const res = await gatewayFetch(
		"/model/new",
		{ model_name: modelName, litellm_params: litellmParams },
		"POST",
		fetchImpl,
	);
	if (res.status >= 400) {
		throw new Error(
			`litellm /model/new ${res.status}: ${JSON.stringify(res.body)}`,
		);
	}
	return (res.body?.model_id as string | undefined) ?? null;
};

const isGatewayNotFound = (status: number, body: any): boolean => {
	if (status === 404) return true;
	const message = String(
		body?.error?.message ?? body?.error?.detail ?? body?.detail ?? "",
	);
	return /not found|does not exist/i.test(message);
};

/**
 * Removes one deployment from the gateway.  "Already gone" is success -- a
 * deployment whose gateway row was deleted out from under us (a gateway DB
 * reset) should not wedge the merchant's delete.  Any other failure throws:
 * silently leaving a live deployment behind would keep routing calls
 * through a key the merchant believes they removed.
 */
export const removeDeploymentFromGateway = async ({
	gatewayModelId,
	fetchImpl = fetch,
}: {
	gatewayModelId: string;
	fetchImpl?: FetchImpl;
}): Promise<void> => {
	const res = await gatewayFetch(
		"/model/delete",
		{ id: gatewayModelId },
		"POST",
		fetchImpl,
	);
	if (res.status < 400 || isGatewayNotFound(res.status, res.body)) return;
	throw new Error(
		`litellm /model/delete ${res.status}: ${JSON.stringify(res.body)}`,
	);
};

export const listDeployments = async ({
	ctx,
	orgId,
	env,
	modelId,
}: {
	ctx: AutumnContext;
	orgId: string;
	env: string;
	modelId?: string;
}): Promise<ServedModelDeployment[]> => {
	const filters = [
		eq(servedModelDeployments.org_id, orgId),
		eq(servedModelDeployments.env, env),
	];
	if (modelId) filters.push(eq(servedModelDeployments.model_id, modelId));

	return ctx.db
		.select()
		.from(servedModelDeployments)
		.where(and(...filters))
		.orderBy(asc(servedModelDeployments.created_at));
};

export const getDeployment = async ({
	ctx,
	modelId,
	deploymentId,
}: {
	ctx: AutumnContext;
	modelId: string;
	deploymentId: string;
}): Promise<ServedModelDeployment | undefined> => {
	return ctx.db.query.servedModelDeployments.findFirst({
		where: and(
			eq(servedModelDeployments.org_id, ctx.org.id),
			eq(servedModelDeployments.env, ctx.env),
			eq(servedModelDeployments.model_id, modelId),
			eq(servedModelDeployments.internal_id, deploymentId),
		),
	});
};

/**
 * Points the served row's `upstream_model` at this model's deployment group
 * while deployments exist, and clears it when the last one goes.  Only the
 * dashboard's own value is ever cleared -- a merchant who hand-set
 * `upstream_model` at a static gateway alias keeps it.
 *
 * Returns true when the value moved, because the allow-list stamped into the
 * org's gateway keys carries `upstream_model ?? model_id` and has to be
 * re-synced when it does.
 */
const refreshUpstreamModel = async ({
	ctx,
	modelId,
}: {
	ctx: AutumnContext;
	modelId: string;
}): Promise<boolean> => {
	const { db, org, env } = ctx;
	const remaining = await listDeployments({ ctx, orgId: org.id, env, modelId });
	const desired =
		remaining.length > 0
			? gatewayDeploymentName({ env, orgId: org.id, modelId })
			: null;

	const row = await db.query.servedModels.findFirst({
		where: and(
			eq(servedModels.org_id, org.id),
			eq(servedModels.env, env),
			eq(servedModels.model_id, modelId),
		),
	});
	if (!row) return false;

	const managedName = gatewayDeploymentName({ env, orgId: org.id, modelId });
	if (row.upstream_model === desired) return false;
	// Taking over on the first deployment is intended; letting a delete
	// clobber a value the merchant typed in afterwards is not.
	if (desired === null && row.upstream_model !== managedName) return false;

	await db
		.update(servedModels)
		.set({ upstream_model: desired, updated_at: Date.now() })
		.where(eq(servedModels.internal_id, row.internal_id));
	return true;
};

const toGatewayError = (error: unknown): RecaseError =>
	new RecaseError({
		message: `The gateway refused the deployment: ${(error as Error).message}`,
		code: ErrCode.InternalError,
		statusCode: 502,
	});

/**
 * The API shape of a deployment: everything the dashboard may see. Secrets
 * (the key, the extra-params blob) come back only as hints — the key's last
 * four characters and the extra params' key names.
 */
export const toDeploymentResponse = (d: ServedModelDeployment) => ({
	id: d.internal_id,
	model_id: d.model_id,
	provider_model: d.provider_model,
	api_base: d.api_base,
	api_key_hint: d.api_key_hint,
	rpm: d.rpm,
	tpm: d.tpm,
	timeout: d.timeout,
	max_retries: d.max_retries,
	weight: d.weight,
	order: d.routing_order,
	organization: d.organization,
	extra_params_keys: d.extra_params_keys ?? [],
	created_at: d.created_at,
});

export const createDeployment = async ({
	ctx,
	modelId,
	input,
	fetchImpl = fetch,
}: {
	ctx: AutumnContext;
	modelId: string;
	input: DeploymentInput & { provider_model: string; api_key: string };
	fetchImpl?: FetchImpl;
}): Promise<ServedModelDeployment> => {
	const { db, org, env } = ctx;
	const modelName = gatewayDeploymentName({ env, orgId: org.id, modelId });
	if (input.extra_params) validateExtraParams(input.extra_params);

	let gatewayModelId: string | null;
	try {
		gatewayModelId = await pushDeploymentToGateway({
			modelName,
			providerModel: input.provider_model,
			apiKey: input.api_key,
			apiBase: input.api_base,
			rpm: input.rpm,
			tpm: input.tpm,
			timeout: input.timeout,
			maxRetries: input.max_retries,
			weight: input.weight,
			routingOrder: input.routing_order,
			organization: input.organization,
			extraParams: input.extra_params,
			fetchImpl,
		});
	} catch (error) {
		throw toGatewayError(error);
	}

	const now = Date.now();
	const [row] = await db
		.insert(servedModelDeployments)
		.values({
			internal_id: generateId("served_deployment"),
			org_id: org.id,
			env,
			model_id: modelId,
			provider_model: input.provider_model,
			api_base: input.api_base ?? null,
			api_key_enc: encryptData(input.api_key),
			api_key_hint: apiKeyHint(input.api_key),
			gateway_model_id: gatewayModelId,
			rpm: input.rpm ?? null,
			tpm: input.tpm ?? null,
			timeout: input.timeout ?? null,
			max_retries: input.max_retries ?? null,
			weight: input.weight ?? null,
			routing_order: input.routing_order ?? null,
			organization: input.organization ?? null,
			...storeExtraParams(input.extra_params ?? {}),
			created_at: now,
			updated_at: now,
		})
		.returning();

	// The first deployment takes over the model's upstream name, which moves
	// the allow-list stamped into the org's gateway keys.
	if (await refreshUpstreamModel({ ctx, modelId })) {
		await syncOrgLitellmKeys(ctx, org.id);
	}

	return row;
};

export const updateDeployment = async ({
	ctx,
	modelId,
	deploymentId,
	input,
	fetchImpl = fetch,
}: {
	ctx: AutumnContext;
	modelId: string;
	deploymentId: string;
	input: DeploymentInput;
	fetchImpl?: FetchImpl;
}): Promise<ServedModelDeployment> => {
	const existing = await getDeployment({ ctx, modelId, deploymentId });
	if (!existing) {
		throw new RecaseError({
			message: `Deployment ${deploymentId} not found`,
			code: ErrCode.InvalidRequest,
			statusCode: 404,
		});
	}

	const providerModel = input.provider_model ?? existing.provider_model;
	// An absent or empty key means "unchanged" -- the stored key is
	// decrypted and re-pushed, because the gateway call is a full re-create.
	const apiKey =
		input.api_key && input.api_key.length > 0
			? input.api_key
			: decryptData(existing.api_key_enc);
	const apiBase =
		input.api_base === undefined ? existing.api_base : input.api_base;
	const rpm = input.rpm === undefined ? existing.rpm : input.rpm;
	const tpm = input.tpm === undefined ? existing.tpm : input.tpm;
	const timeout =
		input.timeout === undefined ? existing.timeout : input.timeout;
	const maxRetries =
		input.max_retries === undefined ? existing.max_retries : input.max_retries;
	const weight =
		input.weight === undefined ? existing.weight : input.weight;
	const routingOrder =
		input.routing_order === undefined
			? existing.routing_order
			: input.routing_order;
	const organization =
		input.organization === undefined
			? existing.organization
			: input.organization;
	// Absent extras keep the stored blob; an explicit object replaces it
	// (an empty object clears, matching the form's "blank keeps, {} clears").
	const extraParams =
		input.extra_params === undefined
			? parseExtraParams(existing.extra_params_enc)
			: (input.extra_params ?? {});
	if (input.extra_params !== undefined) validateExtraParams(extraParams);

	const modelName = gatewayDeploymentName({
		env: ctx.env,
		orgId: ctx.org.id,
		modelId,
	});

	// Delete first, then create: if the create fails, the row still points at
	// the old (now-deleted) gateway id, and the next attempt self-heals --
	// its delete reads as drift and proceeds.  Create-first would strand a
	// live duplicate deployment that no row tracks.
	if (existing.gateway_model_id) {
		try {
			await removeDeploymentFromGateway({
				gatewayModelId: existing.gateway_model_id,
				fetchImpl,
			});
		} catch (error) {
			throw toGatewayError(error);
		}
	}

	let gatewayModelId: string | null;
	try {
		gatewayModelId = await pushDeploymentToGateway({
			modelName,
			providerModel,
			apiKey,
			apiBase,
			rpm,
			tpm,
			timeout,
			maxRetries,
			weight,
			routingOrder,
			organization,
			extraParams,
			fetchImpl,
		});
	} catch (error) {
		throw toGatewayError(error);
	}

	const [row] = await ctx.db
		.update(servedModelDeployments)
		.set({
			provider_model: providerModel,
			api_base: apiBase,
			api_key_enc: encryptData(apiKey),
			api_key_hint: apiKeyHint(apiKey),
			gateway_model_id: gatewayModelId,
			rpm,
			tpm,
			timeout,
			max_retries: maxRetries,
			weight,
			routing_order: routingOrder,
			organization,
			...storeExtraParams(extraParams),
			updated_at: Date.now(),
		})
		.where(eq(servedModelDeployments.internal_id, existing.internal_id))
		.returning();

	return row;
};

export const deleteDeployment = async ({
	ctx,
	modelId,
	deploymentId,
	fetchImpl = fetch,
}: {
	ctx: AutumnContext;
	modelId: string;
	deploymentId: string;
	fetchImpl?: FetchImpl;
}): Promise<void> => {
	const existing = await getDeployment({ ctx, modelId, deploymentId });
	if (!existing) {
		throw new RecaseError({
			message: `Deployment ${deploymentId} not found`,
			code: ErrCode.InvalidRequest,
			statusCode: 404,
		});
	}

	if (existing.gateway_model_id) {
		try {
			await removeDeploymentFromGateway({
				gatewayModelId: existing.gateway_model_id,
				fetchImpl,
			});
		} catch (error) {
			throw toGatewayError(error);
		}
	}

	await ctx.db
		.delete(servedModelDeployments)
		.where(eq(servedModelDeployments.internal_id, existing.internal_id));

	// Removing the last deployment hands the model's upstream name back.
	if (await refreshUpstreamModel({ ctx, modelId })) {
		await syncOrgLitellmKeys(ctx, ctx.org.id);
	}
};
