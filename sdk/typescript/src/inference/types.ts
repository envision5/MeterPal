/**
 * The shapes the MeterPal inference API speaks.
 *
 * The response is the OpenAI shape verbatim -- only `meterpal` is added --
 * so anything that already understands OpenAI can read it unchanged.
 */

export type ChatRole =
	| "system"
	| "user"
	| "assistant"
	| "tool"
	| "function"
	| "developer";

export type ChatMessage = {
	role: ChatRole;
	content?: string | Array<Record<string, unknown>> | null;
	name?: string;
	tool_call_id?: string;
	[key: string]: unknown;
};

export type ChatCompletionRequest = {
	/** A model id from the merchant's served catalog. */
	model: string;
	messages: ChatMessage[];
	/** The end user being billed — their MeterPal customer id. */
	user?: string;
	stream?: boolean;
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string | string[];
	[key: string]: unknown;
};

export type Usage = {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	[key: string]: unknown;
};

/** What the call cost, added to every MeterPal response. */
export type MeterpalBlock = {
	/** Credits the call cost. Null when the charge could not be read back. */
	credits_charged: number | null;
	/** The end user's spendable balance after the call. */
	balance_after: number | null;
	customer_id: string;
	/** The model id the charge was recorded against. */
	model_id: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
};

export type ChatCompletionChoice = {
	index: number;
	message: {
		role: string;
		content: string | null;
		[key: string]: unknown;
	};
	finish_reason: string | null;
	[key: string]: unknown;
};

export type ChatCompletion = {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: ChatCompletionChoice[];
	usage: Usage;
	meterpal: MeterpalBlock;
	[key: string]: unknown;
};

export type ChatCompletionChunkChoice = {
	index: number;
	delta: {
		role?: string;
		content?: string | null;
		[key: string]: unknown;
	};
	finish_reason: string | null;
	[key: string]: unknown;
};

export type ChatCompletionChunk = {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: ChatCompletionChunkChoice[];
	usage?: Usage;
	/** Present on the final chunk, when the call was billed. */
	meterpal?: MeterpalBlock;
	[key: string]: unknown;
};

export type ServedModel = {
	model_id: string;
	display_name: string | null;
	upstream_model: string | null;
	enabled: boolean;
	input_cost_usd_1m: number | null;
	output_cost_usd_1m: number | null;
	markup_pct: number | null;
	[key: string]: unknown;
};

export type Catalog = {
	org_id: string;
	env: string;
	models: ServedModel[];
	/** Null means the merchant serves every model the gateway offers. */
	allowed_model_ids: string[] | null;
};

/** A PayPal checkout the end user can pay. */
export type TopUpResult = {
	/** The URL to send the end user to. */
	url: string;
	/** The checkout id, when the API returned one. */
	id?: string;
};
