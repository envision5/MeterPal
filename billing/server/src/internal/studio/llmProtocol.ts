// billing/server/src/internal/studio/llmProtocol.ts
//
// Translation between AG Studio's conversation protocol and OpenAI's chat
// completion wire format.
//
// AG Studio owns the agent loop: it hands the adapter a conversation, a set
// of tool schemas and an output format, and expects back a list of output
// items (assistant messages, tool calls). The provider is OpenAI-shaped here,
// so this module is the only place that knows both vocabularies.
//
// Nothing in this file talks to the network -- it is pure shape translation,
// so it is trivially testable and cannot have side effects.

/** One conversation item as AG Studio sends it. */
export type StudioConversationItem = {
	kind?: "input" | "output";
	type?: string;
	role?: string;
	id?: string;
	/** Content parts for messages; a plain string is tolerated. */
	content?: unknown;
	/** Tool calls. */
	callId?: string;
	name?: string;
	arguments?: string;
	/** Tool results. */
	output?: string;
};

/** One tool schema as AG Studio sends it. */
export type StudioToolSchema = {
	name: string;
	description?: string;
	parameters?: unknown;
	kind?: string;
};

/** The request body AG Studio's `AgLlmRequest` carries. */
export type StudioLlmRequest = {
	input?: StudioConversationItem[];
	instructions?: string;
	tools?: StudioToolSchema[];
	toolChoice?: string | { name: string };
	responseFormat?:
		| { type: "text" }
		| { type: "json"; name?: string; description?: string; schema?: unknown };
	model?: { id?: string; effort?: string };
};

/** An OpenAI-shaped chat message. */
export type OpenAiMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content?: string;
	tool_call_id?: string;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
};

/** The text of a message's content, whatever shape it arrived in. */
const contentToText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const typed = part as {
			type?: string;
			text?: string;
			imageUrl?: string;
			fileUrl?: string;
			filename?: string;
		};
		if (typed.type === "text" && typeof typed.text === "string") {
			parts.push(typed.text);
		} else if (typed.type === "image" && typed.imageUrl) {
			parts.push(`[image: ${typed.imageUrl}]`);
		} else if (typed.type === "file" && (typed.fileUrl || typed.filename)) {
			parts.push(`[file: ${typed.fileUrl ?? typed.filename}]`);
		}
	}
	return parts.join("\n");
};

/**
 * AG Studio's conversation -> OpenAI messages.
 *
 * Tool calls are the fiddly part: OpenAI wants one assistant message holding
 * every call, while AG Studio sends each call as its own item. Consecutive
 * calls are therefore folded into a single assistant message, and the tool
 * results that follow become `role: "tool"` messages keyed by `call_id`.
 */
export const studioRequestToOpenAiMessages = ({
	request,
}: {
	request: StudioLlmRequest;
}): OpenAiMessage[] => {
	const messages: OpenAiMessage[] = [];

	if (request.instructions) {
		messages.push({ role: "system", content: request.instructions });
	}

	const items = request.input ?? [];

	for (let i = 0; i < items.length; i++) {
		const item = items[i];

		if (item.type === "function_call_output") {
			messages.push({
				role: "tool",
				tool_call_id: item.callId ?? item.id ?? "",
				content: item.output ?? "",
			});
			continue;
		}

		if (item.type === "function_call") {
			// Fold this call into the trailing assistant message, or open one.
			const last = messages[messages.length - 1];
			const call = {
				id: item.callId ?? item.id ?? `call_${i}`,
				type: "function" as const,
				function: {
					name: item.name ?? "",
					arguments: item.arguments ?? "{}",
				},
			};
			if (last?.role === "assistant" && last.tool_calls) {
				last.tool_calls.push(call);
			} else {
				messages.push({ role: "assistant", content: "", tool_calls: [call] });
			}
			continue;
		}

		if (item.type === "message") {
			const text = contentToText(item.content);
			const role =
				item.role === "system"
					? "system"
					: item.role === "assistant"
						? "assistant"
						: "user";
			messages.push({ role, content: text });
			continue;
		}

		// A reasoning item carries no text the provider needs.
	}

	return messages;
};

/** AG Studio's tool schemas -> OpenAI's `tools` array. */
export const studioToolsToOpenAiTools = ({
	tools,
}: {
	tools?: StudioToolSchema[];
}): Array<{
	type: "function";
	function: { name: string; description: string; parameters: unknown };
}> | undefined => {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters ?? { type: "object", properties: {} },
		},
	}));
};

/** AG Studio's tool choice -> OpenAI's `tool_choice`. */
export const studioToolChoiceToOpenAi = ({
	toolChoice,
}: {
	toolChoice?: string | { name: string };
}): string | { type: "function"; function: { name: string } } | undefined => {
	if (!toolChoice) return undefined;
	if (typeof toolChoice === "string") {
		return toolChoice === "none" || toolChoice === "auto" || toolChoice === "required"
			? toolChoice
			: undefined;
	}
	return { type: "function", function: { name: toolChoice.name } };
};

/** AG Studio's output format -> OpenAI's `response_format`. */
export const studioResponseFormatToOpenAi = ({
	responseFormat,
}: {
	responseFormat?: StudioLlmRequest["responseFormat"];
}): Record<string, unknown> | undefined => {
	if (!responseFormat || responseFormat.type === "text") return undefined;
	return {
		type: "json_schema",
		json_schema: {
			name: responseFormat.name ?? "response",
			...(responseFormat.description
				? { description: responseFormat.description }
				: {}),
			schema: responseFormat.schema ?? { type: "object" },
		},
	};
};

/** The OpenAI chat completion this module expects back. */
export type OpenAiChatCompletion = {
	id?: string;
	created?: number;
	model?: string;
	choices?: Array<{
		index?: number;
		finish_reason?: string | null;
		message?: {
			role?: string;
			content?: string | null;
			tool_calls?: Array<{
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
};

/** One AG Studio output item. */
export type StudioOutputItem =
	| {
			id: string;
			kind: "output";
			type: "message";
			role: "assistant";
			status: "completed";
			content: Array<{ type: "text"; text: string; annotations: [] }>;
	  }
	| {
			id: string;
			kind: "output";
			type: "function_call";
			callId: string;
			name: string;
			arguments: string;
			status: "completed";
	  };

/** The response AG Studio's `AgLlmResponse` expects. */
export type StudioLlmResponse = {
	id: string;
	createdAt: number;
	status: "completed" | "failed" | "incomplete";
	output: StudioOutputItem[];
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens?: number;
	};
	model?: string;
	error?: { code: string; message: string };
};

/**
 * An OpenAI chat completion -> AG Studio's response shape.
 *
 * The text (if any) becomes one assistant message; each tool call becomes one
 * `function_call` output item, which Studio then executes and feeds back.
 */
export const openAiCompletionToStudioResponse = ({
	completion,
	fallbackId,
}: {
	completion: OpenAiChatCompletion;
	fallbackId: string;
}): StudioLlmResponse => {
	const choice = completion.choices?.[0];
	const message = choice?.message;

	const output: StudioOutputItem[] = [];

	const text = message?.content ?? "";
	if (text) {
		output.push({
			id: `${completion.id ?? fallbackId}_msg`,
			kind: "output",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "text", text, annotations: [] }],
		});
	}

	for (const [index, call] of (message?.tool_calls ?? []).entries()) {
		const callId = call.id ?? `${fallbackId}_call_${index}`;
		output.push({
			id: callId,
			kind: "output",
			type: "function_call",
			callId,
			name: call.function?.name ?? "",
			arguments: call.function?.arguments ?? "{}",
			status: "completed",
		});
	}

	const promptTokens = completion.usage?.prompt_tokens ?? 0;
	const completionTokens = completion.usage?.completion_tokens ?? 0;

	return {
		id: completion.id ?? fallbackId,
		createdAt: (completion.created ?? Date.now() / 1000) * 1000,
		status: "completed",
		output,
		usage: {
			inputTokens: promptTokens,
			outputTokens: completionTokens,
			totalTokens: completion.usage?.total_tokens ?? promptTokens + completionTokens,
		},
		...(completion.model ? { model: completion.model } : {}),
	};
};
