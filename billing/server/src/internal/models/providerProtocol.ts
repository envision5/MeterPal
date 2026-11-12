// billing/server/src/internal/models/providerProtocol.ts
//
// Translating a catalog model into something LiteLLM can actually route to.
//
// A catalog id is `provider/model` -- `302ai/claude-fable-5`,
// `anthropic/claude-haiku-4-5`. LiteLLM routes on a provider prefix of its
// own, and the two vocabularies only overlap by accident: `302ai` is not a
// LiteLLM provider, and neither is `claude`. Pushing either one to
// /model/new does not fail where the mistake was made -- the proxy saves the
// row, the router drops the deployment with "LLM Provider NOT provided", and
// the caller gets a 500 about pods reloading. The merchant sees a red toast
// and a saved model that serves nothing.
//
// So the translation happens here, before anything is pushed:
//
//   * a catalog entry is turned into the deployment a merchant would have
//     configured by hand (provider prefix, base URL, modalities), which is
//     what lets the dashboard ask for nothing but an API key;
//   * a prefix LiteLLM does not know is refused with the id that would have
//     worked, instead of a 500 from three layers down.

/**
 * LiteLLM's own provider vocabulary, generated from
 * `litellm/types/utils.py::LlmProviders`. A prefix outside this set cannot
 * be routed: `get_llm_provider` finds no provider, and the deployment is
 * dropped from the router.
 *
 * Regenerate rather than hand-edit when the gateway is upgraded.
 */
export const LITELLM_PROVIDERS: ReadonlySet<string> = new Set([
	"a2a", "a2a_agent", "agentcore", "ai21", "ai21_chat", "aiml",
	"aiohttp_openai", "amazon_nova", "anthropic", "anthropic_text", "apertis",
	"apiserpent", "assemblyai", "auto_router", "aws_polly", "aws_textract",
	"azure", "azure_ai", "azure_speech", "azure_text", "baseten", "bedrock",
	"bedrock_mantle", "bing_grounding", "black_forest_labs", "brave", "bytez",
	"cerebras", "charity_engine", "chatgpt", "chutes", "clarifai", "cloudflare",
	"codestral", "cognition", "cohere", "cohere_chat", "cometapi",
	"compactifai", "cursor", "custom", "custom_openai", "darkbloom",
	"dashscope", "databricks", "dataforseo", "datarobot", "deepgram",
	"deepinfra", "deepseek", "docker_model_runner", "dotprompt", "duckduckgo",
	"e2b", "edenai", "elevenlabs", "empower", "exa_ai", "fal_ai", "fastcrw",
	"featherless_ai", "firecrawl", "fireworks_ai", "friendliai", "galadriel",
	"gdc", "gemini", "gigachat", "github", "github_copilot", "google_pse",
	"gradient_ai", "groq", "helicone", "heroku", "hosted_vllm", "huggingface",
	"humanloop", "hyperbolic", "inception", "infinity", "jina_ai", "lambda_ai",
	"langflow", "langfuse", "langgraph", "lemonade", "libertai", "linkup",
	"litellm_agent", "litellm_proxy", "llamafile", "lm_studio", "manus",
	"maritalk", "meta", "meta_llama", "milvus", "minimax", "mistral",
	"modelscope", "mongodb", "moonshot", "morph", "nadir", "nano-gpt", "nebius",
	"neosantara", "nimble", "nlp_cloud", "novita", "nscale", "nvidia_nim",
	"nvidia_riva", "oci", "ollama", "ollama_chat", "oobabooga", "openai",
	"openai_like", "openrouter", "opensandbox", "ovhcloud", "parallel_ai",
	"parasail", "perplexity", "petals", "pg_vector", "pinstripes", "poe",
	"predibase", "publicai", "qwen_ai_platform", "qwencloud", "ragflow",
	"recraft", "reducto", "replicate", "runwayml", "s3_vectors", "sagemaker",
	"sagemaker_chat", "sagemaker_nova", "sail", "sambanova", "sap", "scaleway",
	"scx-ai", "searchapi", "searxng", "serper", "snowflake", "soniox",
	"stability", "synthetic", "tavily", "tencent", "tensormesh",
	"text-completion-codestral", "text-completion-inception",
	"text-completion-openai", "tinyfish", "together_ai", "topaz", "transcribe",
	"triton", "v0", "valkey", "vercel_ai_gateway", "vertex_ai",
	"vertex_ai_beta", "vllm", "volcengine", "voyage", "wandb", "watsonx",
	"watsonx_text", "xai", "xiaomi_mimo", "xinference", "you_com", "zai",
]);

/**
 * The wire protocol behind each models.dev provider, keyed by the AI SDK
 * package the catalog reports. 196 of models.dev's 235 providers are plain
 * OpenAI-compatible endpoints, which is why that is also the fallback.
 */
const PROTOCOL_BY_NPM: Record<string, string> = {
	"@ai-sdk/openai-compatible": "openai",
	"@ai-sdk/openai": "openai",
	"@ai-sdk/anthropic": "anthropic",
	"@ai-sdk/google": "gemini",
	"@ai-sdk/google-vertex": "vertex_ai",
	"@ai-sdk/google-vertex/anthropic": "vertex_ai",
	"@ai-sdk/azure": "azure",
	"@ai-sdk/amazon-bedrock": "bedrock",
	"@ai-sdk/cohere": "cohere",
	"@ai-sdk/mistral": "mistral",
	"@ai-sdk/groq": "groq",
	"@ai-sdk/xai": "xai",
	"@ai-sdk/cerebras": "cerebras",
	"@ai-sdk/perplexity": "perplexity",
	"@ai-sdk/deepinfra": "deepinfra",
	"@ai-sdk/togetherai": "together_ai",
	"@openrouter/ai-sdk-provider": "openrouter",
};

/**
 * Prefixes people type that are a provider's *name*, not LiteLLM's id for
 * it. Kept separate from the fuzzy match below because these are correct in
 * every other API and wrong in exactly one place.
 */
const PROVIDER_ALIASES: Record<string, string> = {
	claude: "anthropic",
	anthropic_vertex: "vertex_ai",
	google: "gemini",
	google_vertex: "vertex_ai",
	"google-vertex": "vertex_ai",
	amazon_bedrock: "bedrock",
	"amazon-bedrock": "bedrock",
	azure_openai: "azure",
	"azure-openai": "azure",
	together: "together_ai",
	togetherai: "together_ai",
	fireworks: "fireworks_ai",
	"fireworks-ai": "fireworks_ai",
	grok: "xai",
	"x-ai": "xai",
	mistralai: "mistral",
	cohereai: "cohere",
	vertex: "vertex_ai",
	moonshotai: "moonshot",
	qwen: "dashscope",
	alibaba: "dashscope",
	novita_ai: "novita",
	"novita-ai": "novita",
	openrouter_ai: "openrouter",
};

/** The modalities a chat model can take input in, in the order the form
 *  shows them. `text` is always true and is not stored. */
export const INPUT_MODALITIES = ["image", "audio", "pdf", "video"] as const;
export type InputModality = (typeof INPUT_MODALITIES)[number];

/** The split point of `provider/model`. The model key keeps any further
 *  slashes -- openrouter ids are `openrouter/anthropic/claude-3.5-sonnet`. */
export const splitProviderModel = (
	providerModel: string,
): { prefix: string; modelKey: string } | null => {
	const index = providerModel.indexOf("/");
	if (index <= 0 || index === providerModel.length - 1) return null;
	return {
		prefix: providerModel.slice(0, index),
		modelKey: providerModel.slice(index + 1),
	};
};

/**
 * The LiteLLM prefix for a catalog provider.
 *
 * A provider LiteLLM knows by name wins: `deepseek` is OpenAI-compatible,
 * but routing it through `openai/` would throw away LiteLLM's own base URL
 * and cost map for it. Everything else is routed by the protocol it speaks,
 * which is what makes a 302.AI key work at all.
 */
export const litellmProviderFor = ({
	providerId,
	npm,
}: {
	providerId: string;
	npm?: string | null;
}): string => {
	if (LITELLM_PROVIDERS.has(providerId)) return providerId;
	if (npm && PROTOCOL_BY_NPM[npm]) return PROTOCOL_BY_NPM[npm];
	return "openai";
};

/** Levenshtein distance, capped at `limit` so a hopeless match exits early. */
const distance = (a: string, b: string, limit: number): number => {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let best = current[0];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + cost,
			);
			current.push(value);
			if (value < best) best = value;
		}
		if (best > limit) return limit + 1;
		previous = current;
	}
	return previous[b.length];
};

/** The provider a typo probably meant, or null when nothing is close. */
export const nearestProvider = (prefix: string): string | null => {
	const normalized = prefix.toLowerCase();
	const alias = PROVIDER_ALIASES[normalized];
	if (alias) return alias;

	const limit = normalized.length <= 4 ? 1 : 3;
	let best: { name: string; score: number } | null = null;
	for (const candidate of LITELLM_PROVIDERS) {
		const score = distance(normalized, candidate, limit);
		if (score > limit) continue;
		if (!best || score < best.score) best = { name: candidate, score };
	}
	return best?.name ?? null;
};

/**
 * Refuses a provider prefix LiteLLM cannot route, naming the one that would
 * have worked. Returns null when the prefix is fine.
 *
 * `suggestion` overrides the guess: the caller knows which served model this
 * deployment belongs to, and the catalog knows how the gateway serves it. For
 * a `302ai/...` model the guess below would offer `anthropic/...` — a
 * provider the merchant has no key for.
 */
export const providerModelProblem = (
	providerModel: string,
	{ suggestion }: { suggestion?: string | null } = {},
): string | null => {
	const parts = splitProviderModel(providerModel.trim());
	if (!parts) {
		return `"${providerModel}" is not a provider/model id -- use one like openai/gpt-4o-mini.`;
	}
	if (LITELLM_PROVIDERS.has(parts.prefix)) return null;

	const nearest = nearestProvider(parts.prefix);
	const suggestedId =
		suggestion ?? (nearest ? `${nearest}/${parts.modelKey}` : null);
	const suggestionClause = suggestedId
		? ` Did you mean ${suggestedId}?`
		: " Use a provider the gateway supports, e.g. openai/<model> for an OpenAI-compatible endpoint.";
	return `The gateway has no provider called "${parts.prefix}", so it would save the deployment and then refuse to route to it.${suggestionClause}`;
};


/**
 * A base URL, not an endpoint.
 *
 * Every SDK LiteLLM wraps appends its own path, so a merchant who pastes the
 * URL from their provider's docs -- `.../v1/messages`, `.../v1/chat/
 * completions` -- gets a request to `.../v1/messages/v1/messages`. The
 * suffix is dropped here rather than left to fail at the first call, and the
 * corrected value comes back in the response, so the form shows what was
 * stored.
 */
const ENDPOINT_SUFFIXES = [
	"/chat/completions",
	"/v1/messages",
	"/completions",
] as const;

export const normalizeApiBase = (apiBase: string): string => {
	let value = apiBase.trim().replace(/\/+$/, "");
	for (const suffix of ENDPOINT_SUFFIXES) {
		if (value.toLowerCase().endsWith(suffix)) {
			value = value.slice(0, -suffix.length).replace(/\/+$/, "");
			break;
		}
	}
	return value;
};

/**
 * The `model_info` LiteLLM reads capabilities from.
 *
 * The distinction that matters: `undefined` means "not configured" and sends
 * nothing, while an empty array means "text only" and sends explicit
 * falsehoods. LiteLLM treats a missing `supports_vision` as "might work" --
 * it only refuses images when the flag is present and false -- so a merchant
 * who deliberately unchecks every box has to say so, not say nothing.
 *
 * `supports_video_input` has no consumer in this gateway: LiteLLM has no
 * video gate, so the flag is recorded for the merchant and for any client
 * reading /v1/model/info, but nothing enforces it.
 */
export const buildModelInfo = (
	modalities: readonly string[] | null | undefined,
): Record<string, boolean> | null => {
	if (modalities == null) return null;
	const has = (modality: InputModality) => modalities.includes(modality);
	return {
		supports_vision: has("image"),
		supports_audio_input: has("audio"),
		supports_pdf_input: has("pdf"),
		supports_video_input: has("video"),
	};
};

/** Catalog modalities, reduced to the ones the form offers. */
export const modalitiesFromCatalog = (
	input: readonly string[] | undefined,
): string[] => {
	if (!input) return [];
	return INPUT_MODALITIES.filter((modality) => input.includes(modality));
};
