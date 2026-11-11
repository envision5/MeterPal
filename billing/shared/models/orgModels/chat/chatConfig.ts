import { z } from "zod/v4";

// The merchant's settings for the chat surface their app exposes to end
// users.  Stored in `organizations.metadata` under `chat_config`, next to
// `seller_agent_mandate` / `buyer_agent_defaults` but a separate key: those
// two describe what an AGENT may do, this one describes how the APP answers.
//
//   streaming   deliver tokens as they arrive instead of one whole response.
//
// Streaming defaults to ON.  It is the better experience (the first token
// lands in milliseconds instead of after the whole generation), and it is
// what makes the wallet visibly drain while a call is in flight.  A merchant
// turns it off when their client cannot read an event stream.

export const ChatConfigSchema = z.object({
	/** Deliver responses as a token stream rather than a single payload. */
	streaming: z.boolean().default(true),
});

export type ChatConfig = z.infer<typeof ChatConfigSchema>;

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
	streaming: true,
};

const METADATA_KEY = "chat_config";

/**
 * Read the chat config out of the org's metadata blob.
 *
 * `organizations.metadata` is a TEXT column holding JSON.  A parse failure or
 * a malformed object falls back to the shipped default rather than to "off":
 * a broken blob must not silently downgrade every response to
 * non-streaming, and it must never be read as a permissive value.
 */
export const readChatConfig = (
	metadata: string | null | undefined,
): ChatConfig => {
	let parsed: Record<string, unknown> | null = null;
	if (metadata) {
		try {
			const json = JSON.parse(metadata);
			if (json && typeof json === "object") {
				parsed = json as Record<string, unknown>;
			}
		} catch {
			parsed = null;
		}
	}

	const chat = ChatConfigSchema.safeParse(parsed?.[METADATA_KEY]);
	return chat.success ? chat.data : DEFAULT_CHAT_CONFIG;
};

/**
 * Merge a validated chat config back into the raw metadata blob, preserving
 * every unrelated key another feature stored there.
 */
export const writeChatConfig = (
	metadata: string | null | undefined,
	config: Partial<ChatConfig>,
): string => {
	let base: Record<string, unknown> = {};
	if (metadata) {
		try {
			const json = JSON.parse(metadata);
			if (json && typeof json === "object") {
				base = json as Record<string, unknown>;
			}
		} catch {
			base = {};
		}
	}

	const current = readChatConfig(metadata);
	base[METADATA_KEY] = {
		...current,
		...(config.streaming === undefined ? {} : { streaming: config.streaming }),
	};

	return JSON.stringify(base);
};
