// billing/vite/src/views/studio/studioAdapter.ts
//
// The metered LLM adapter.
//
// AG Studio never talks to a model provider: the app supplies an
// `AgLlmAdapter`, and this is ours. The adapter forwards the turn to the
// billing server's `/studio/ai`, which runs it through the same metered
// inference path as every other completion in the product -- the customer's
// wallet pays, and an empty wallet is a paywall.
//
// The point of the demo lives here: the agent that builds the merchant's
// dashboard is itself billed. A turn that costs credits shows up as a smaller
// balance for the customer the dashboard is about.

import type {
	AgAiEvent,
	AgLlmAdapter,
	AgLlmRequest,
	AgLlmResponse,
} from "ag-studio";
import type { AxiosInstance } from "axios";

/** What the server adds to every metered response. */
export type MeterpalBlock = {
	credits_charged: number | null;
	balance_after: number | null;
	customer_id: string;
	model_id: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
};

export type MeteredResponse = AgLlmResponse & { meterpal?: MeterpalBlock };

/**
 * The completed response, as the protocol's event stream.
 *
 * The turn is not streamed from the model -- it comes back whole from the
 * metered endpoint -- so the events are derived from the finished response
 * rather than parsed off a wire. Studio reads them the same either way.
 */
async function* eventsFromResponse(
	response: Promise<MeteredResponse>,
): AsyncGenerator<AgAiEvent> {
	const resolved = await response;

	for (const item of resolved.output ?? []) {
		if (item.type === "message") {
			yield { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" };
			for (const part of item.content ?? []) {
				if (part.type === "text" && part.text) {
					yield {
						type: "TEXT_MESSAGE_CONTENT",
						messageId: item.id,
						delta: part.text,
					};
				}
			}
			yield { type: "TEXT_MESSAGE_END", messageId: item.id };
			continue;
		}

		if (item.type === "function_call") {
			yield {
				type: "TOOL_CALL_START",
				toolCallId: item.callId,
				toolCallName: item.name,
			};
			yield {
				type: "TOOL_CALL_ARGS",
				toolCallId: item.callId,
				delta: item.arguments ?? "{}",
			};
			yield { type: "TOOL_CALL_END", toolCallId: item.callId };
		}
	}
}

export const createMeteredAdapter = ({
	axios,
	customerId,
	model,
	onMetered,
}: {
	axios: AxiosInstance;
	customerId: string;
	model?: string;
	/** Called with what each turn cost, so the page can show it. */
	onMetered?: (block: MeterpalBlock) => void;
}): AgLlmAdapter => ({
	executeTurn: (request: AgLlmRequest, options) => {
		const response = (async () => {
			const { data } = await axios.post(
				"/studio/ai",
				{
					customer_id: customerId,
					...(model ? { model } : {}),
					request,
				},
				options?.signal ? { signal: options.signal } : undefined,
			);
			const resolved = data as MeteredResponse;
			if (resolved.meterpal) onMetered?.(resolved.meterpal);
			return resolved;
		})();

		return {
			stream: {
				[Symbol.asyncIterator]: () => eventsFromResponse(response),
			},
			complete: response,
		};
	},
});
