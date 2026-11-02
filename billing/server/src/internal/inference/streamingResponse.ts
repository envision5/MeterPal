// billing/server/src/internal/inference/streamingResponse.ts
//
// Passing a streamed completion through, with the charge attached.
//
// The gateway streams Server-Sent Events.  The proxy forwards them as they
// arrive -- the merchant's app sees the first token at the same speed it
// would from OpenAI -- and appends one final event carrying what the call
// cost, just before the terminating [DONE].
//
// The terminating [DONE] is withheld until the charge is known, because a
// client that stops reading at [DONE] would otherwise miss the meterpal
// block entirely.

const SSE_SEPARATOR = "\n\n";

/** Split a buffer into complete SSE events and the remainder. */
const splitSseEvents = (buffer: string): { events: string[]; rest: string } => {
	const parts = buffer.split(SSE_SEPARATOR);
	const rest = parts.pop() ?? "";
	return { events: parts, rest };
};

const isDoneEvent = (event: string) => /data:\s*\[DONE\]/.test(event);

export type MeterpalStreamOptions = {
	/** The gateway's event stream. */
	body: ReadableStream<Uint8Array>;
	/** Resolves the meterpal block once the upstream stream ends. */
	settle: () => Promise<unknown>;
};

/**
 * Forward an SSE stream and append the meterpal block before [DONE].
 */
export const createMeterpalSseStream = ({
	body,
	settle,
}: MeterpalStreamOptions): ReadableStream<Uint8Array> => {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = body.getReader();
			let buffer = "";

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const { events, rest } = splitSseEvents(buffer);
					buffer = rest;

					for (const event of events) {
						// The terminator is emitted at the very end, after the
						// meterpal block.
						if (isDoneEvent(event)) continue;
						controller.enqueue(encoder.encode(`${event}${SSE_SEPARATOR}`));
					}
				}

				buffer += decoder.decode();
				const tail = buffer.trim();
				if (tail && !isDoneEvent(tail)) {
					controller.enqueue(encoder.encode(`${tail}${SSE_SEPARATOR}`));
				}

				const meterpal = await settle();
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ meterpal })}${SSE_SEPARATOR}`,
					),
				);
				controller.enqueue(encoder.encode(`data: [DONE]${SSE_SEPARATOR}`));
				controller.close();
			} catch (error) {
				controller.error(error);
			} finally {
				try {
					reader.releaseLock();
				} catch {
					// The stream was already released; nothing to do.
				}
			}
		},
	});
};
