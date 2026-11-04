// Unit tests for the deployment service's gateway boundary.
//
// The DB-backed flows (upstream_model transitions, key re-sync) run in the
// integration lane against the real Postgres and gateway; here we pin the
// pure pieces: naming, the push/delete payloads, and the drift tolerance of
// removes. The gateway is always a mocked transport — nothing here dials out.

import { describe, expect, mock, test } from "bun:test";

process.env.ENCRYPTION_PASSWORD ??= "unit-test-encryption-password";

const {
	apiKeyHint,
	buildLitellmParams,
	gatewayDeploymentName,
	pushDeploymentToGateway,
	removeDeploymentFromGateway,
	validateExtraParams,
} = await import("../../../src/internal/models/deploymentService.js");

const { decryptData, encryptData } = await import(
	"../../../src/utils/encryptUtils.js"
);

/** A fetch transport that records the (path, body) of each call. */
const recordingTransport = (
	respond: (path: string) => Response,
): { fetchImpl: typeof fetch; calls: Array<{ path: string; body: any }> } => {
	const calls: Array<{ path: string; body: any }> = [];
	const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
		const path = String(input).replace(/^https?:\/\/[^/]+/, "");
		const rawBody = String(init?.body ?? "{}");
		calls.push({ path, body: JSON.parse(rawBody) });
		return respond(path);
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
};

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

describe("gatewayDeploymentName", () => {
	test("namespaces by env and org so orgs never share a router group", () => {
		const a = gatewayDeploymentName({
			env: "sandbox",
			orgId: "org-1",
			modelId: "openai/gpt-4o-mini",
		});
		const b = gatewayDeploymentName({
			env: "sandbox",
			orgId: "org-2",
			modelId: "openai/gpt-4o-mini",
		});
		const live = gatewayDeploymentName({
			env: "live",
			orgId: "org-1",
			modelId: "openai/gpt-4o-mini",
		});
		expect(a).not.toBe(b);
		expect(a).not.toBe(live);
	});

	test("sanitizes the model id to [A-Za-z0-9_.-] — no slashes", () => {
		const name = gatewayDeploymentName({
			env: "sandbox",
			orgId: "org-1",
			modelId: "openai/gpt-4o-mini",
		});
		// The bridge resolves names by the segment after the last slash, so a
		// slash in the name would break the bare-name fallback.
		expect(name).not.toContain("/");
		expect(name).toBe("mp_sandbox_org-1__openai-gpt-4o-mini");
	});

	test("keeps safe characters readable", () => {
		expect(
			gatewayDeploymentName({
				env: "live",
				orgId: "org_9",
				modelId: "custom/demo-gpt_v2",
			}),
		).toBe("mp_live_org_9__custom-demo-gpt_v2");
	});
});

describe("apiKeyHint", () => {
	test("keeps only the last four characters", () => {
		expect(apiKeyHint("sk-proj-abcd1234")).toBe("1234");
	});

	test("passes through keys shorter than four", () => {
		expect(apiKeyHint("abc")).toBe("abc");
	});
});

describe("pushDeploymentToGateway", () => {
	test("POSTs /model/new with the namespaced name and litellm params", async () => {
		const { fetchImpl, calls } = recordingTransport(() =>
			json(200, { model_id: "gw-row-1" }),
		);

		const id = await pushDeploymentToGateway({
			modelName: "mp_sandbox_org-1__custom-demo",
			providerModel: "openai/demo-gpt",
			apiKey: "sk-test-9999",
			apiBase: "http://127.0.0.1:9999/v1",
			rpm: 60.4,
			tpm: null,
			fetchImpl,
		});

		expect(id).toBe("gw-row-1");
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe("/model/new");
		expect(calls[0].body.model_name).toBe("mp_sandbox_org-1__custom-demo");
		expect(calls[0].body.litellm_params.model).toBe("openai/demo-gpt");
		expect(calls[0].body.litellm_params.api_key).toBe("sk-test-9999");
		expect(calls[0].body.litellm_params.api_base).toBe(
			"http://127.0.0.1:9999/v1",
		);
		// Rate ceilings are ints; a null ceiling is simply omitted.
		expect(calls[0].body.litellm_params.rpm).toBe(60);
		expect(calls[0].body.litellm_params).not.toHaveProperty("tpm");
	});

	test("omits api_base when the deployment has none", async () => {
		const { fetchImpl, calls } = recordingTransport(() =>
			json(200, { model_id: "gw-row-2" }),
		);

		await pushDeploymentToGateway({
			modelName: "mp_sandbox_org-1__openai-gpt-4o-mini",
			providerModel: "openai/gpt-4o-mini",
			apiKey: "sk-test-0001",
			fetchImpl,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].body.litellm_params).not.toHaveProperty("api_base");
		expect(calls[0].body.litellm_params).not.toHaveProperty("rpm");
		expect(calls[0].body.litellm_params).not.toHaveProperty("tpm");
	});

	test("throws with the gateway's detail on a 400", async () => {
		const { fetchImpl } = recordingTransport(() =>
			json(400, { error: { message: "bad provider prefix" } }),
		);

		expect(
			pushDeploymentToGateway({
				modelName: "mp_sandbox_org-1__x",
				providerModel: "nonsense",
				apiKey: "sk-test",
				fetchImpl,
			}),
		).rejects.toThrow("litellm /model/new 400");
	});
});

describe("removeDeploymentFromGateway", () => {
	test("200 resolves", async () => {
		const { fetchImpl } = recordingTransport(() =>
			json(200, { message: "deleted" }),
		);
		await expect(
			removeDeploymentFromGateway({ gatewayModelId: "gw-1", fetchImpl }),
		).resolves.toBeUndefined();
	});

	test("a 404 is drift, not failure — the row still gets deleted", async () => {
		const { fetchImpl } = recordingTransport(() =>
			json(404, { error: "no such model" }),
		);
		await expect(
			removeDeploymentFromGateway({ gatewayModelId: "gw-gone", fetchImpl }),
		).resolves.toBeUndefined();
	});

	test("a real failure throws so the caller stops", async () => {
		const { fetchImpl } = recordingTransport(() =>
			json(500, { error: { message: "db unavailable" } }),
		);
		await expect(
			removeDeploymentFromGateway({ gatewayModelId: "gw-1", fetchImpl }),
		).rejects.toThrow("litellm /model/delete 500");
	});
});

describe("buildLitellmParams", () => {
	test("maps first-class fields and rounds the integer knobs", () => {
		const params = buildLitellmParams({
			providerModel: "openai/gpt-4o-mini",
			apiKey: "sk-test",
			apiBase: "http://127.0.0.1:9999/v1",
			rpm: 60.4,
			tpm: null,
			timeout: 3.5,
			maxRetries: 2.4,
			weight: 3,
			routingOrder: 1,
			organization: "org_demo",
			extraParams: { aws_region_name: "us-east-1", tags: ["alpha"] },
		});

		expect(params.model).toBe("openai/gpt-4o-mini");
		expect(params.api_key).toBe("sk-test");
		expect(params.api_base).toBe("http://127.0.0.1:9999/v1");
		expect(params.rpm).toBe(60);
		expect(params).not.toHaveProperty("tpm");
		expect(params.timeout).toBe(3.5);
		expect(params.max_retries).toBe(2);
		expect(params.weight).toBe(3);
		// LiteLLM's param is `order`; the column is routing_order.
		expect(params.order).toBe(1);
		expect(params.organization).toBe("org_demo");
		expect(params.aws_region_name).toBe("us-east-1");
		expect(params.tags).toEqual(["alpha"]);
	});

	test("omits every unset optional", () => {
		const params = buildLitellmParams({
			providerModel: "openai/gpt-4o-mini",
			apiKey: "sk-test",
		});
		for (const key of [
			"api_base",
			"rpm",
			"tpm",
			"timeout",
			"max_retries",
			"weight",
			"order",
			"organization",
		]) {
			expect(params).not.toHaveProperty(key);
		}
	});
});

describe("validateExtraParams", () => {
	test("accepts anything the merchant needs from LiteLLM's surface", () => {
		expect(() =>
			validateExtraParams({
				api_version: "2024-02-01",
				vertex_project: "my-project",
				aws_region_name: "us-east-1",
				tags: ["claude-code"],
				cooldown_time: 30,
			}),
		).not.toThrow();
	});

	test("rejects params the dashboard owns as first-class fields", () => {
		expect(() => validateExtraParams({ api_key: "sneaky" })).toThrow(
			/api_key/,
		);
		expect(() => validateExtraParams({ order: 1, rpm: 10 })).toThrow(
			/order, rpm/,
		);
	});

	test("rejects pricing and budget params — the price sheet owns those", () => {
		expect(() =>
			validateExtraParams({ input_cost_per_token: 0.001 }),
		).toThrow(/price sheet/);
		expect(() => validateExtraParams({ max_budget: 5 })).toThrow(/configured elsewhere/);
	});
});

describe("provider key storage", () => {
	test("encrypts to something that is not the key and decrypts back", () => {
		const key = "sk-provider-9876543210";
		const enc = encryptData(key);
		expect(enc).not.toContain(key);
		expect(decryptData(enc)).toBe(key);
	});
});
