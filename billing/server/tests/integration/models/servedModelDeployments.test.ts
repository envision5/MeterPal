// Integration: dashboard-managed model deployments, end to end.
//
// Requires the full local stack: billing server (:8080), gateway (:4000)
// with STORE_MODEL_IN_DB=True, and the mock LLM (:9999).  Skips with a
// message when any of them is unreachable, so lanes without the stack
// report a skip rather than a failure.
//
// The flow is the merchant's own path: price sheet -> instances -> gateway
// group -> a real metered call -> teardown, with the gateway's model list
// checked directly at each step.

import { expect, test } from "bun:test";
import { eq, and } from "drizzle-orm";
import { servedModels } from "@autumn/shared";
import { initScenario } from "@tests/utils/testInitUtils/initScenario";
import { AutumnInt } from "@/external/autumn/autumnCli.js";
import { constructAiCreditSystem } from "@/internal/features/utils/constructFeatureUtils.js";
import { FeatureService } from "@/internal/features/FeatureService.js";
import { gatewayEnv } from "@/internal/keys/litellmEnv.js";
import { gatewayDeploymentName } from "@/internal/models/deploymentService.js";
import { ensureSetupCustomer } from "@/internal/setup/setupUtils.js";

const SERVER_URL = process.env.AUTUMN_BASE_URL ?? "http://localhost:8080";
const GATEWAY_URL =
	process.env.LITELLM_BASE_URL ??
	gatewayEnv().LITELLM_BASE_URL ??
	"http://localhost:4000";
const GATEWAY_KEY =
	process.env.LITELLM_MASTER_KEY ?? gatewayEnv().LITELLM_MASTER_KEY ?? "";
const MOCK_LLM_BASE =
	gatewayEnv().MOCK_LLM_BASE_URL ?? "http://127.0.0.1:9999/v1";

const withTimeout = async (url: string, ms = 2000): Promise<boolean> => {
	try {
		const res = await Promise.race([
			fetch(url),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
		]);
		return res !== null;
	} catch {
		return false;
	}
};

const stackUp = {
	server: await withTimeout(`${SERVER_URL}/health`),
	gateway: await withTimeout(`${GATEWAY_URL}/health/liveliness`),
	mockLlm: await withTimeout("http://127.0.0.1:9999/healthz"),
};
const stackReady = stackUp.server && stackUp.gateway && stackUp.mockLlm;
if (!stackReady) {
	console.warn(
		`[servedModelDeployments] skipping — stack not up: ${JSON.stringify(stackUp)}`,
	);
}

const gatewayFetch = async (path: string, method = "GET", body?: unknown) => {
	const res = await fetch(`${GATEWAY_URL}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${GATEWAY_KEY}`,
			"Content-Type": "application/json",
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	return (await res.json()) as any;
};

/** The gateway deployments registered under a model name. */
const gatewayGroup = async (modelName: string) => {
	const info = await gatewayFetch("/model/info");
	return (info.data ?? []).filter((d: any) => d.model_name === modelName);
};

test.skipIf(!stackReady)(
	"served model deployments: configure in the dashboard, serve through the gateway",
	async () => {
		const { ctx } = await initScenario({ setup: [], actions: [] });
		const { db, org, orgSecretKey } = ctx;
		const autumn = new AutumnInt({ secretKey: orgSecretKey });

		// The bridge admits on the org's AI credit feature (default id
		// `ai_tokens`), and a fresh test org ships without one — seed it the
		// way the feature seed does, then give the dedicated setup customer
		// credits, or every call is refused at the gate (402).
		if (!ctx.features.some((f: any) => f.id === "ai_tokens")) {
			await FeatureService.insert({
				db,
				data: [
					constructAiCreditSystem({
						featureId: "ai_tokens",
						orgId: org.id,
						env: ctx.env,
						modelMarkups: {},
					}),
				],
				logger: console,
			});
		}
		await ensureSetupCustomer({ ctx });
		await autumn.post("/balances/create", {
			feature_id: "ai_tokens",
			customer_id: "meterpal-setup-test",
			included_grant: 100,
		});

		const modelId = `custom/deploy-e2e-${Date.now()}`;
		const modelName = gatewayDeploymentName({
			env: ctx.env,
			orgId: org.id,
			modelId,
		});

		try {
			// ── 1. A custom model on the price sheet ──────────────────────
			await autumn.post("/served_models", {
				model_id: modelId,
				display_name: "Deploy E2E",
				enabled: true,
				input_cost_usd_1m: 1.5,
				output_cost_usd_1m: 6,
			});

			// ── 2. Two instances, two keys, both pointed at the mock LLM ──
			const create1 = await autumn.post(
				`/served_models/${encodeURIComponent(modelId)}/deployments`,
				{
					provider_model: "openai/deploy-e2e",
					api_key: "sk-deploy-e2e-alpha-1111",
					api_base: MOCK_LLM_BASE,
				},
			);
			const create2 = await autumn.post(
				`/served_models/${encodeURIComponent(modelId)}/deployments`,
				{
					provider_model: "openai/deploy-e2e",
					api_key: "sk-deploy-e2e-beta-2222",
					api_base: MOCK_LLM_BASE,
					rpm: 30,
					timeout: 3.5,
					max_retries: 2,
					order: 1,
					organization: "org-e2e-demo",
					extra_params: {
						aws_region_name: "us-east-1",
						tags: ["deploy-e2e"],
					},
				},
			);
			expect(create1.deployment.api_key_hint).toBe("1111");
			expect(create2.deployment.api_key_hint).toBe("2222");
			expect(create2.deployment.order).toBe(1);
			expect(create2.deployment.extra_params_keys).toEqual([
				"aws_region_name",
				"tags",
			]);
			// The extra-params values never come back — only the key names.
			expect(JSON.stringify(create2)).not.toContain("us-east-1");
			expect(create1.deployment.id).not.toBe(create2.deployment.id);

			// Params MeterPal manages elsewhere are refused outright.
			let reservedRejected = false;
			try {
				await autumn.post(
					`/served_models/${encodeURIComponent(modelId)}/deployments`,
					{
						provider_model: "openai/deploy-e2e",
						api_key: "sk-deploy-e2e-x",
						extra_params: { api_key: "sneaky", rpm: 10 },
					},
				);
			} catch (error: any) {
				reservedRejected = String(error.message).includes(
					"configured elsewhere",
				);
			}
			expect(reservedRejected).toBe(true);

			// ── 3. The sheet names the gateway group; the gateway has it ──
			const [sheetRow] = await db
				.select({ upstream: servedModels.upstream_model })
				.from(servedModels)
				.where(
					and(
						eq(servedModels.org_id, org.id),
						eq(servedModels.env, ctx.env),
						eq(servedModels.model_id, modelId),
					),
				);
			expect(sheetRow?.upstream).toBe(modelName);

			const listed = await autumn.get("/served_models");
			const listedModel = listed.models.find(
				(m: any) => m.model_id === modelId,
			);
			expect(listedModel.upstream_model).toBe(modelName);
			expect(listedModel.deployments).toHaveLength(2);
			// The stored key never leaves the server.
			expect(JSON.stringify(listedModel)).not.toContain("sk-deploy-e2e");

			const group = await gatewayGroup(modelName);
			expect(group).toHaveLength(2);
			const rpmValues = group.map(
				(d: any) => d.litellm_params.rpm ?? null,
			);
			expect(rpmValues).toContain(30);
			expect(rpmValues).toContain(null);

			// The advanced settings landed on the gateway verbatim.
			const advanced = group.find(
				(d: any) => d.litellm_params.organization === "org-e2e-demo",
			);
			expect(advanced).toBeTruthy();
			expect(advanced.litellm_params.timeout).toBe(3.5);
			expect(advanced.litellm_params.max_retries).toBe(2);
			expect(advanced.litellm_params.order).toBe(1);
			expect(advanced.litellm_params.aws_region_name).toBe("us-east-1");
			expect(advanced.litellm_params.tags).toEqual(["deploy-e2e"]);

			// ── 4. A real metered call through the whole chain ────────────
			// (The setup wizard's smoke test is dashboard-session-only; this is
			// the same chain as a merchant app makes it: price sheet -> gateway
			// group -> bridge -> billed to the end user.)
			const meteredCall = async () =>
				fetch(`${SERVER_URL}/v1/chat/completions`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${orgSecretKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: modelId,
						messages: [{ role: "user", content: "Say hello." }],
						user: "meterpal-setup-test",
					}),
				});

			const first = await meteredCall();
			expect(first.status).toBe(200);
			const firstBody = await first.json();
			expect(firstBody.meterpal.customer_id).toBe("meterpal-setup-test");
			expect(firstBody.meterpal.model_id).toBe(modelId);
			expect(firstBody.meterpal.credits_charged).not.toBeNull();

			// ── 5. Concurrency: parallel calls across the group ───────────
			const calls = await Promise.all(
				[1, 2, 3, 4].map(() => meteredCall()),
			);
			for (const call of calls) {
				expect(call.status).toBe(200);
				const body = await call.json();
				expect(body.meterpal.model_id).toBe(modelId);
			}

			// ── 6. Rotating a key lands on the gateway ────────────────────
			const patched = await autumn.patch(
				`/served_models/${encodeURIComponent(modelId)}/deployments/${create1.deployment.id}`,
				{ api_key: "sk-deploy-e2e-gamma-3333" },
			);
			expect(patched.deployment.api_key_hint).toBe("3333");

			// ── 6b. Clearing extras with {} also lands ────────────────────
			const clearedExtras = await autumn.patch(
				`/served_models/${encodeURIComponent(modelId)}/deployments/${create2.deployment.id}`,
				{ extra_params: {} },
			);
			expect(clearedExtras.deployment.extra_params_keys).toEqual([]);
			const groupAfterClear = await gatewayGroup(modelName);
			const advancedAfterClear = groupAfterClear.find(
				(d: any) => d.litellm_params.organization === "org-e2e-demo",
			);
			expect(advancedAfterClear).toBeTruthy();
			expect(advancedAfterClear.litellm_params).not.toHaveProperty(
				"aws_region_name",
			);
			expect(advancedAfterClear.litellm_params).not.toHaveProperty("tags");
			// The first-class fields survive the extras clear.
			expect(advancedAfterClear.litellm_params.organization).toBe(
				"org-e2e-demo",
			);

			// ── 7. Removing one instance leaves the model serving ─────────
			await autumn.delete(
				`/served_models/${encodeURIComponent(modelId)}/deployments/${create2.deployment.id}`,
			);
			expect(await gatewayGroup(modelName)).toHaveLength(1);
			const stillServing = await meteredCall();
			expect(stillServing.status).toBe(200);

			// ── 8. Removing the last one hands routing back ───────────────
			await autumn.delete(
				`/served_models/${encodeURIComponent(modelId)}/deployments/${create1.deployment.id}`,
			);
			expect(await gatewayGroup(modelName)).toHaveLength(0);
			const [clearedRow] = await db
				.select({ upstream: servedModels.upstream_model })
				.from(servedModels)
				.where(
					and(
						eq(servedModels.org_id, org.id),
						eq(servedModels.env, ctx.env),
						eq(servedModels.model_id, modelId),
					),
				);
			expect(clearedRow?.upstream).toBeNull();

			// ── 9. Deleting the model clears anything left on the gateway ─
			await autumn.post(
				`/served_models/${encodeURIComponent(modelId)}/deployments`,
				{
					provider_model: "openai/deploy-e2e",
					api_key: "sk-deploy-e2e-delta-4444",
					api_base: MOCK_LLM_BASE,
				},
			);
			expect(await gatewayGroup(modelName)).toHaveLength(1);
			await autumn.delete(`/served_models/${encodeURIComponent(modelId)}`);
			expect(await gatewayGroup(modelName)).toHaveLength(0);
		} finally {
			// Leftovers must not pollute the org's sheet or the gateway.
			try {
				for (const d of (await gatewayGroup(modelName)) ?? []) {
					await gatewayFetch("/model/delete", "POST", { id: d.model_info.id });
				}
			} catch {}
			try {
				await autumn.delete(`/served_models/${encodeURIComponent(modelId)}`);
			} catch {}
		}
	},
);
