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

// ---------------------------------------------------------------------------
// Tool argument repair
// ---------------------------------------------------------------------------
//
// Two repairs, both driven by the schema Studio published for the turn, both
// strictly faithful: they only reshape what the model already said, and only
// where the schema says what shape it must be. Studio runs its tools
// client-side, so a call it cannot parse fails somewhere this server never
// sees -- the agent loop shows "Failed" and stops, with no error to chase.

const DELEGATE_TO_TOOL = "delegate_to";

/** A JSON-schema node, as much of it as these repairs need. */
type SchemaNode = {
	type?: string | string[];
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	anyOf?: SchemaNode[];
	oneOf?: SchemaNode[];
	allOf?: SchemaNode[];
	enum?: unknown;
};

/**
 * Does this schema want an object or an array?
 *
 * A union counts when any branch wants one: `delegate_to`'s `type` is an
 * `anyOf` of objects, and the model stringifies it just like a plain object
 * property.
 */
const wantsStructured = (schema: SchemaNode | undefined): boolean => {
	if (!schema) return false;
	const types = Array.isArray(schema.type) ? schema.type : [schema.type];
	if (types.includes("object") || types.includes("array")) return true;
	return (schema.anyOf ?? []).some(wantsStructured) ||
		(schema.oneOf ?? []).some(wantsStructured) ||
		(schema.allOf ?? []).some(wantsStructured);
};

/**
 * Undo JSON-encoded nesting, guided by the schema.
 *
 * Models routinely send a nested argument as a JSON *string* -- `"model":
 * "{\"operator\":\"inRelativeRange\",...}"` instead of the object itself --
 * because emitting a string is a flatter, easier token sequence than emitting
 * the structure. The tool then validates a string against an object schema and
 * rejects it, and the model, seeing no explanation it can act on, retries the
 * same call until the loop gives up.
 *
 * So: wherever the schema wants an object or array and the value is a string
 * that parses to one, parse it. A string the schema wants as a string is never
 * touched, and a string that does not parse is left as it was.
 */
const unstringify = (value: unknown, schema: SchemaNode | undefined): unknown => {
	if (!schema) return value;

	if (typeof value === "string" && wantsStructured(schema)) {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (parsed !== null && typeof parsed === "object") {
				return unstringify(parsed, schema);
			}
		} catch {
			return value;
		}
		return value;
	}

	if (Array.isArray(value) && schema.items) {
		return value.map((entry) => unstringify(entry, schema.items));
	}

	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const properties = schema.properties ?? {};
		// A union of objects: every branch's properties are candidates.
		const branches = [
			...(schema.anyOf ?? []),
			...(schema.oneOf ?? []),
			...(schema.allOf ?? []),
		];
		let changed = false;
		const next: Record<string, unknown> = { ...record };

		for (const key of Object.keys(record)) {
			const child =
				properties[key] ??
				branches.map((branch) => branch.properties?.[key]).find(Boolean);
			if (!child) continue;
			const repaired = unstringify(record[key], child);
			if (repaired !== record[key]) {
				next[key] = repaired;
				changed = true;
			}
		}

		return changed ? next : value;
	}

	return value;
};

/** The target ids `delegate_to` accepts, read from the schema it published. */
const delegateTargetIds = (schema: SchemaNode | undefined): Set<string> => {
	const ids = new Set<string>();
	const branches = schema?.properties?.type?.anyOf ?? [];
	for (const branch of branches) {
		const values = branch?.properties?.id?.enum;
		if (Array.isArray(values)) {
			for (const value of values) {
				if (typeof value === "string") ids.add(value);
			}
		}
	}
	return ids;
};

/**
 * Repair a `delegate_to` call the model flattened.
 *
 * Studio's schema wants `type: { id, ...params }`. A model that flattens
 * discriminated unions -- which most do, whatever the schema says -- sends
 * `type: "page"` with the params beside it instead. Studio then reads
 * `args.type.id`, finds nothing, and rejects the call with "no target agent
 * specified", so the agent loop dies on its first hand-off no matter how
 * correct the plan was.
 *
 * The repair is faithful, not creative: it only fires when the flattened
 * `type` names a target the published schema actually offers, and it only
 * moves arguments the caller already sent. Anything it cannot confirm is left
 * exactly as the model emitted it, so a genuinely wrong call still surfaces as
 * a real error rather than a silent guess.
 */
const repairDelegateArguments = ({
	args,
	targets,
}: {
	args: Record<string, unknown>;
	targets: Set<string>;
}): Record<string, unknown> => {
	if (targets.size === 0) return args;

	const { type, instructions, ...rest } = args;

	// Already in the shape Studio asked for -- but a model will also sometimes
	// send `{ type: { id: "widget" }, widgetType: "line-chart" }`, which parses
	// as a valid discriminant with the widget's own params left outside it.
	// Studio would then validate `type` against the widget branch and fail on
	// the missing `widgetType`, so fold the strays back in.
	if (type && typeof type === "object" && !Array.isArray(type)) {
		if (Object.keys(rest).length === 0) return args;
		return { ...args, type: { ...(type as Record<string, unknown>), ...rest } };
	}

	// The flattened form. `type` is the target id; everything beside it that is
	// not the instruction belongs to that target's params.
	if (typeof type !== "string" || !targets.has(type)) return args;

	return {
		...(instructions === undefined ? {} : { instructions }),
		type: { id: type, ...rest },
	};
};

/**
 * The arguments to hand Studio for one tool call.
 *
 * Unparseable arguments are returned untouched: a model that truncated its own
 * JSON should reach Studio as it wrote it, not become a 500 here.
 */
const repairToolArguments = ({
	raw,
	schema,
}: {
	raw: string;
	schema?: StudioToolSchema;
}): string => {
	let args: Record<string, unknown>;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return raw;
		}
		args = parsed as Record<string, unknown>;
	} catch {
		return raw;
	}

	const node = schema?.parameters as SchemaNode | undefined;
	const repaired = unstringify(args, node) as Record<string, unknown>;

	if (schema?.name !== DELEGATE_TO_TOOL) return JSON.stringify(repaired);

	const targets = delegateTargetIds(node);
	return JSON.stringify(
		repairDelegateArguments({ args: repaired, targets }),
	);
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
 *
 * `tools` is the same list the request went out with. It is used only to
 * repair a flattened `delegate_to` (see `repairDelegateArguments`) -- Studio
 * executes that tool client-side, so a call it cannot parse is a dead end the
 * server would otherwise never hear about.
 */
export const openAiCompletionToStudioResponse = ({
	completion,
	fallbackId,
	tools,
}: {
	completion: OpenAiChatCompletion;
	fallbackId: string;
	tools?: StudioToolSchema[];
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

	const byName = new Map((tools ?? []).map((tool) => [tool.name, tool]));

	for (const [index, call] of (message?.tool_calls ?? []).entries()) {
		const callId = call.id ?? `${fallbackId}_call_${index}`;
		const name = call.function?.name ?? "";
		output.push({
			id: callId,
			kind: "output",
			type: "function_call",
			callId,
			name,
			arguments: repairToolArguments({
				raw: call.function?.arguments ?? "{}",
				schema: byName.get(name),
			}),
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
