// billing/vite/src/views/studio/studioAdapter.ts
//
// The metered LLM adapter.
//
// AG Studio never talks to a model provider: the app supplies an
// `AgLlmAdapter`, and this is ours. The adapter forwards the turn to the
// billing server's `/studio/ai`, which runs it through the same metered
// inference path as every other completion in the product -- a wallet pays,
// and an empty wallet is a paywall.
//
// WHICH WALLET. The merchant's, always. Building this dashboard is the
// merchant working, so the turn bills their console wallet
// (`meterpal-console`) and nothing else. The customer being viewed is sent as
// `scope_customer_id`, which only says what the assistant is talking about.
// The server cannot bill an end user from this route even if asked, because
// the request has no field for it -- that is deliberate: a merchant poking at
// their own analytics must never move a customer's balance.

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
	/** The wallet that paid. Always the merchant's console wallet. */
	customer_id: string;
	model_id: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
};

export type MeteredResponse = AgLlmResponse & { meterpal?: MeterpalBlock };

/** What the server returns instead of a completion when the wallet can't pay. */
type PaywallBody = {
	error?: {
		type?: string;
		code?: string;
		message?: string;
		customer_id?: string;
		balance?: number;
		/** What the turn would have cost, when the refusal states it. */
		required_credits?: number;
	};
};

/**
 * A 402 is not a transport failure, it is the product working.
 *
 * The gateway refuses the turn before any provider is called when the
 * console wallet's balance is below what the turn could cost, so the merchant
 * is told what actually happened and what to do about it, rather than being
 * handed "Request failed with status code 402".
 *
 * The wording matters: this is the merchant's own console balance, not any
 * customer's. Saying "this customer's wallet" here was how the old bug read
 * on screen -- it described a bill that should never have been theirs.
 */
const describePaywall = (body: PaywallBody | undefined): string => {
	const error = body?.error;
	const balance = error?.balance;
	const required = error?.required_credits;
	const held =
		typeof balance === "number"
			? ` Balance is ${Math.round(balance * 100) / 100} credits.`
			: "";
	const needed =
		typeof required === "number"
			? ` This turn reserves up to ${Math.round(required * 100) / 100}.`
			: "";

	return `The assistant is paywalled: your console wallet can't cover the turn, so nothing was charged and no customer was billed.${held}${needed} Top up the MeterPal Console wallet to keep using the assistant.`;
};

/**
 * Reasoning blocks are not chat.
 *
 * The model the demo serves emits its chain of thought inline as
 * `<think>…</think>` before the answer. Studio renders message content as the
 * assistant talking, so the reasoning showed up in the panel as a wall of
 * "Let me re-read the workflow…" above the one useful sentence — in the beat
 * whose whole point is that the agent is doing the work, not narrating it.
 *
 * The blocks are stripped here, at the boundary, so the reasoning is still
 * generated (and still metered — those are the tokens the wallet paid for)
 * and simply not shown.
 */
const stripReasoning = (text: string): string =>
	text
		.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
		// An unterminated block is still reasoning, not an answer.
		.replace(/<think(?:ing)?>[\s\S]*$/i, "")
		.trim();

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
			const parts = (item.content ?? [])
				.filter((part) => part.type === "text" && part.text)
				.map((part) => stripReasoning((part as { text: string }).text))
				.filter(Boolean);
			// A message that was nothing but reasoning has nothing to say.
			if (parts.length === 0) continue;

			yield { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" };
			for (const text of parts) {
				yield {
					type: "TEXT_MESSAGE_CONTENT",
					messageId: item.id,
					delta: text,
				};
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
	scopeCustomerId,
	model,
	onMetered,
	onPaywalled,
}: {
	axios: AxiosInstance;
	/** Whose usage the dashboard is showing. Scope only -- never billed. */
	scopeCustomerId?: string;
	model?: string;
	/** Called with what each turn cost, so the page can show it. */
	onMetered?: (block: MeterpalBlock) => void;
	/** Called when the turn was refused for lack of balance. */
	onPaywalled?: (balance: number | null) => void;
}): AgLlmAdapter => ({
	executeTurn: (request: AgLlmRequest, options) => {
		const response = (async () => {
			try {
				const { data } = await axios.post(
					"/studio/ai",
					{
						...(scopeCustomerId ? { scope_customer_id: scopeCustomerId } : {}),
						...(model ? { model } : {}),
						request,
					},
					options?.signal ? { signal: options.signal } : undefined,
				);
				const resolved = data as MeteredResponse;
				if (resolved.meterpal) onMetered?.(resolved.meterpal);
				return resolved;
			} catch (error) {
				const response = (
					error as {
						response?: { status?: number; data?: PaywallBody & { message?: string } };
					}
				).response;
				const status = response?.status;
				const body = response?.data;

				if (status === 402) {
					onPaywalled?.(body?.error?.balance ?? null);
					throw new Error(describePaywall(body));
				}

				// Everything else: the server explains itself in `error.message`
				// (gateway refusals, a model the org doesn't serve, a bad
				// request). Passing that through beats "Request failed with
				// status code 502", which tells the user nothing and hides a
				// server-side cause behind a transport-looking one.
				const detail = body?.error?.message ?? body?.message;
				if (detail) throw new Error(detail);
				throw error;
			}
		})();

		return {
			stream: {
				[Symbol.asyncIterator]: () => eventsFromResponse(response),
			},
			complete: response,
		};
	},
});
