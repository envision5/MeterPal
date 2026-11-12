// The catalog-to-gateway translation.
//
// These pin the two halves of the same bug: a catalog id is not a LiteLLM
// deployment (`302ai/claude-fable-5` is served as `openai/claude-fable-5`),
// and a prefix LiteLLM has never heard of is saved happily and then dropped
// by the router, which surfaces as a 500 about pods rather than a sentence
// about the model.

import { describe, expect, test } from "bun:test";

const {
	buildModelInfo,
	litellmProviderFor,
	modalitiesFromCatalog,
	nearestProvider,
	normalizeApiBase,
	providerModelProblem,
	splitProviderModel,
} = await import("../../../src/internal/models/providerProtocol.js");

const { cleanModalities, validateDeploymentTarget } = await import(
	"../../../src/internal/models/deploymentService.js"
);

describe("litellmProviderFor", () => {
	test("keeps a provider LiteLLM knows by name, even when it is OpenAI-compatible", () => {
		// deepseek speaks the OpenAI protocol, but routing it through
		// `openai/` would throw away LiteLLM's own base URL and cost map.
		expect(
			litellmProviderFor({
				providerId: "deepseek",
				npm: "@ai-sdk/openai-compatible",
			}),
		).toBe("deepseek");
		expect(litellmProviderFor({ providerId: "anthropic" })).toBe("anthropic");
	});

	test("routes an aggregator by the protocol it speaks", () => {
		// 302.AI is 196 of models.dev's 235 providers: no LiteLLM provider of
		// its own, an OpenAI-compatible endpoint behind a base URL.
		expect(
			litellmProviderFor({
				providerId: "302ai",
				npm: "@ai-sdk/openai-compatible",
			}),
		).toBe("openai");
	});

	test("maps the native protocols whose catalog id is not the LiteLLM id", () => {
		expect(
			litellmProviderFor({ providerId: "google", npm: "@ai-sdk/google" }),
		).toBe("gemini");
		expect(
			litellmProviderFor({
				providerId: "amazon-bedrock",
				npm: "@ai-sdk/amazon-bedrock",
			}),
		).toBe("bedrock");
		expect(
			litellmProviderFor({
				providerId: "google-vertex",
				npm: "@ai-sdk/google-vertex",
			}),
		).toBe("vertex_ai");
	});

	test("falls back to OpenAI-compatible for a provider it has never seen", () => {
		expect(litellmProviderFor({ providerId: "brand-new-gateway" })).toBe(
			"openai",
		);
	});
});

describe("providerModelProblem", () => {
	test("accepts a prefix the gateway can route", () => {
		expect(providerModelProblem("openai/gpt-4o-mini")).toBeNull();
		expect(providerModelProblem("anthropic/claude-haiku-4-5")).toBeNull();
	});

	test("names the id that would have worked", () => {
		const problem = providerModelProblem("claude/claude-fable-5");
		expect(problem).toContain("claude");
		expect(problem).toContain("anthropic/claude-fable-5");
	});

	test("refuses a bare model name", () => {
		expect(providerModelProblem("gpt-4o-mini")).toContain("provider/model");
	});

	test("a near-miss provider is suggested by distance, not just by alias", () => {
		expect(nearestProvider("antropic")).toBe("anthropic");
		expect(nearestProvider("claude")).toBe("anthropic");
		expect(nearestProvider("completely-unrelated")).toBeNull();
	});
});

describe("splitProviderModel", () => {
	test("keeps slashes in the model key — openrouter ids have them", () => {
		expect(splitProviderModel("openrouter/anthropic/claude-3.5-sonnet")).toEqual(
			{ prefix: "openrouter", modelKey: "anthropic/claude-3.5-sonnet" },
		);
	});

	test("rejects ids with no model or no provider", () => {
		expect(splitProviderModel("openai/")).toBeNull();
		expect(splitProviderModel("/gpt-4o")).toBeNull();
		expect(splitProviderModel("gpt-4o")).toBeNull();
	});
});

describe("normalizeApiBase", () => {
	test("drops an endpoint path the SDK appends itself", () => {
		expect(normalizeApiBase("https://api.anthropic.com/v1/messages")).toBe(
			"https://api.anthropic.com",
		);
		expect(normalizeApiBase("https://api.openai.com/v1/chat/completions")).toBe(
			"https://api.openai.com/v1",
		);
	});

	test("keeps a base URL as given, minus trailing slashes", () => {
		expect(normalizeApiBase("https://api.302.ai/v1/")).toBe(
			"https://api.302.ai/v1",
		);
		expect(normalizeApiBase("https://api.minimax.io/anthropic/v1")).toBe(
			"https://api.minimax.io/anthropic/v1",
		);
	});
});

describe("buildModelInfo", () => {
	test("sends nothing when modalities were never configured", () => {
		expect(buildModelInfo(null)).toBeNull();
		expect(buildModelInfo(undefined)).toBeNull();
	});

	test("sends explicit falsehoods for text-only, which is not the same thing", () => {
		// LiteLLM reads a missing supports_vision as "might work" and only
		// refuses images on an explicit false, so [] has to mean something.
		expect(buildModelInfo([])).toEqual({
			supports_vision: false,
			supports_audio_input: false,
			supports_pdf_input: false,
			supports_video_input: false,
		});
	});

	test("maps each checkbox to the flag the gateway reads", () => {
		expect(buildModelInfo(["image", "pdf"])).toEqual({
			supports_vision: true,
			supports_audio_input: false,
			supports_pdf_input: true,
			supports_video_input: false,
		});
	});
});

describe("modalitiesFromCatalog", () => {
	test("keeps only the inputs the form offers, in form order", () => {
		expect(
			modalitiesFromCatalog(["text", "pdf", "image", "video", "file"]),
		).toEqual(["image", "pdf", "video"]);
	});

	test("an absent catalog field is unknown, not text-only", () => {
		expect(modalitiesFromCatalog(undefined)).toEqual([]);
	});
});

describe("cleanModalities", () => {
	test("keeps known values, deduplicated and stable", () => {
		expect(cleanModalities(["pdf", "image", "pdf", "hologram"])).toEqual([
			"image",
			"pdf",
		]);
	});

	test("null stays null — clearing is not the same as text-only", () => {
		expect(cleanModalities(null)).toBeNull();
		expect(cleanModalities([])).toEqual([]);
	});
});

describe("validateDeploymentTarget", () => {
	test("returns the corrected base URL", () => {
		expect(
			validateDeploymentTarget({
				providerModel: "anthropic/claude-haiku-4-5",
				apiBase: "https://api.anthropic.com/v1/messages",
			}),
		).toEqual({ apiBase: "https://api.anthropic.com" });
	});

	test("throws a 400 naming the right provider, before anything is pushed", () => {
		expect(() =>
			validateDeploymentTarget({ providerModel: "claude/claude-fable-5" }),
		).toThrow(/anthropic\/claude-fable-5/);
	});
});
