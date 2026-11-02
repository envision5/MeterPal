/**
 * The MeterPal inference client.
 *
 * An OpenAI-shaped client that bills the end user for every call:
 *
 *   const meterpal = createMeterPal({ apiKey: process.env.METERPAL_SECRET_KEY });
 *
 *   const completion = await meterpal.chat.completions.create({
 *     model: "custom/demo-gpt",
 *     messages: [{ role: "user", content: "hi" }],
 *     user: "cus_123",       // the end user being billed
 *   });
 *
 *   completion.meterpal.credits_charged;   // what it cost
 *
 * The secret key stays on the server.  The client mints a per-customer
 * virtual key on first use and caches it, so the merchant's app never has to
 * think about credentials again.
 */

import {
	APIError,
	AuthenticationError,
	ConnectionError,
	CustomerNotFoundError,
	InsufficientBalanceError,
	MeterPalError,
	ModelNotEnabledError,
	ModelNotFoundError,
	RateLimitError,
} from "./errors";
import type {
	Catalog,
	ChatCompletion,
	ChatCompletionChunk,
	ChatCompletionRequest,
	MeterpalBlock,
	TopUpResult,
} from "./types";

export const DEFAULT_BASE_URL = "https://api.meterpal.dev";

export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<Response>;

export type TopUpOptions = {
	/** The product to charge for. Defaults to the merchant's top-up plan. */
	productId?: string;
	/** Where PayPal sends the end user back to. */
	returnUrl?: string;
	/** How many credits the end user is buying. */
	credits?: number;
};

export interface MeterPalConfig {
	/**
	 * The merchant's MeterPal secret key (server-side only), or a customer
	 * virtual key to bill one specific end user.
	 */
	apiKey: string;
	/** The MeterPal API. Defaults to https://api.meterpal.dev */
	baseURL?: string;
	/** A custom fetch, for tests or a proxy. */
	fetch?: FetchLike;
	/**
	 * Create the end user the first time they are billed.
	 *
	 * Defaults to true: the merchant should not have to create a customer
	 * before their users can chat.  The new customer starts with no credits,
	 * so the first call is answered with the paywall.
	 */
	autoCreateCustomer?: boolean;
	/** How long to wait for the API, in milliseconds. Defaults to 120s. */
	timeoutMs?: number;
	/** Extra headers on every request. */
	headers?: Record<string, string>;
}

/**
 * The virtual keys this process has minted.
 *
 * Module-level on purpose: an app that builds a client per request (the
 * usual Next.js route handler shape) should still mint one key per end
 * user, not one per request.
 */
const virtualKeyCache = new Map<string, string>();

const VIRTUAL_KEY_PREFIX = "sk-";

export type MeterPal = {
	chat: {
		completions: {
			/** Run one completion and bill the end user. */
			create(
				params: ChatCompletionRequest,
			): Promise<ChatCompletion>;
			/** Run one completion as a stream of chunks. */
			stream(
				params: ChatCompletionRequest,
			): AsyncGenerator<ChatCompletionChunk, void, unknown>;
		};
	};
	keys: {
		/** Mint (or fetch) the gateway credential for one end user. */
		provision(customerId: string): Promise<{
			key: string;
			customer_id: string;
			created: boolean;
		}>;
	};
	models: {
		/** The models this merchant serves, with their prices. */
		list(): Promise<Catalog>;
	};
};

export function createMeterPal(config: MeterPalConfig): MeterPal {
	const baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const doFetch = config.fetch ?? (globalThis.fetch as FetchLike);
	const autoCreateCustomer = config.autoCreateCustomer ?? true;
	const timeoutMs = config.timeoutMs ?? 120_000;

	if (!config.apiKey) {
		throw new MeterPalError(
			"createMeterPal needs an apiKey — the merchant's MeterPal secret key.",
		);
	}

	/** True when the credential is already a per-customer virtual key. */
	const isVirtualKey = config.apiKey.startsWith(VIRTUAL_KEY_PREFIX);

	const cacheKey = (customerId: string) =>
		`${baseURL}|${config.apiKey}|${customerId}`;

	const request = async ({
		path,
		method,
		body,
		credential,
		accept,
	}: {
		path: string;
		method: string;
		body?: unknown;
		credential: string;
		accept?: string;
	}): Promise<Response> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await doFetch(`${baseURL}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${credential}`,
					"Content-Type": "application/json",
					...(accept ? { Accept: accept } : {}),
					...(config.headers ?? {}),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: controller.signal,
			});
		} catch (error) {
			throw new ConnectionError(
				error instanceof Error && error.name === "AbortError"
					? `MeterPal request timed out after ${timeoutMs}ms`
					: `Could not reach MeterPal at ${baseURL}`,
				{ cause: error },
			);
		} finally {
			clearTimeout(timer);
		}
	};

	/**
	 * The credential to bill this end user with.
	 *
	 * A merchant secret key is exchanged for a per-customer virtual key on
	 * first use; the gateway only ever sees per-customer keys, so one
	 * merchant's traffic can never spend another merchant's budget.
	 *
	 * Minting the key is also the first moment we learn the end user does
	 * not exist, so that is where they get created.
	 */
	const resolveCredential = async (customerId: string): Promise<string> => {
		if (isVirtualKey) return config.apiKey;

		const cached = virtualKeyCache.get(cacheKey(customerId));
		if (cached) return cached;

		let response = await request({
			path: "/v1/keys",
			method: "POST",
			body: { customer_id: customerId },
			credential: config.apiKey,
		});
		let data = await readJson(response);

		if (!response.ok) {
			const error = toError(response.status, data);
			// Minting a key can only fail with 404 when the end user does not
			// exist, so that is where they get created: the merchant's app
			// needs no setup step before their users can chat.
			if (response.status === 404 && autoCreateCustomer) {
				await createCustomer(customerId);
				response = await request({
					path: "/v1/keys",
					method: "POST",
					body: { customer_id: customerId },
					credential: config.apiKey,
				});
				data = await readJson(response);
				if (!response.ok) throw toError(response.status, data);
			} else {
				throw error;
			}
		}

		const key = data?.key as string | undefined;
		if (!key) {
			throw new APIError("MeterPal did not return an inference key");
		}
		virtualKeyCache.set(cacheKey(customerId), key);
		return key;
	};

	/** Create the end user, so the merchant never has to. */
	const createCustomer = async (customerId: string): Promise<void> => {
		const response = await request({
			path: "/v1/customers",
			method: "POST",
			body: { customer_id: customerId },
			credential: config.apiKey,
		});
		const data = await readJson(response);
		if (!response.ok) throw toError(response.status, data);
	};

	/** Open a PayPal checkout for the end user. */
	const createCheckout = async ({
		customerId,
		productId,
		returnUrl,
	}: {
		customerId: string;
		productId?: string;
		returnUrl?: string;
	}): Promise<TopUpResult> => {
		const response = await request({
			path: "/v1/checkout",
			method: "POST",
			body: {
				customer_id: customerId,
				...(productId ? { product_id: productId } : {}),
				...(returnUrl ? { success_url: returnUrl } : {}),
			},
			credential: config.apiKey,
		});
		const data = await readJson(response);
		if (!response.ok) throw toError(response.status, data);

		const url =
			data?.paymentUrl ??
			data?.payment_url ??
			data?.checkout_url ??
			data?.url;
		if (!url) {
			throw new APIError("MeterPal did not return a checkout URL");
		}
		return { url, id: data?.id ?? data?.checkout_id };
	};

	return {
		chat: {
			completions: {
				create: async (params) => {
					const customerId = requireUser(params);
					let credential = await resolveCredential(customerId);

					let response = await request({
						path: "/v1/chat/completions",
						method: "POST",
						body: { ...params, user: customerId },
						credential,
					});
					let data = await readJson(response);

					// The end user does not exist yet: create them and try
					// again, so the merchant's app needs no setup step.
					if (
						!response.ok &&
						response.status === 404 &&
						(data?.code === "customer_not_found" ||
							data?.error?.code === "customer_not_found") &&
						autoCreateCustomer
					) {
						await createCustomer(customerId);
						virtualKeyCache.delete(cacheKey(customerId));
						credential = await resolveCredential(customerId);
						response = await request({
							path: "/v1/chat/completions",
							method: "POST",
							body: { ...params, user: customerId },
							credential,
						});
						data = await readJson(response);
					}

					if (!response.ok) {
						throw decorate(toError(response.status, data), {
							customerId,
							createCheckout,
						});
					}
					return data as ChatCompletion;
				},

				stream: async function* (params) {
					const customerId = requireUser(params);
					const credential = await resolveCredential(customerId);

					const response = await request({
						path: "/v1/chat/completions",
						method: "POST",
						body: { ...params, user: customerId, stream: true },
						credential,
						accept: "text/event-stream",
					});

					if (!response.ok) {
						const data = await readJson(response);
						throw decorate(toError(response.status, data), {
							customerId,
							createCheckout,
						});
					}
					if (!response.body) {
						throw new APIError("MeterPal returned an empty stream");
					}

					for await (const payload of readSse(response.body)) {
						yield payload as ChatCompletionChunk;
					}
				},
			},
		},

		keys: {
			provision: async (customerId) => {
				const response = await request({
					path: "/v1/keys",
					method: "POST",
					body: { customer_id: customerId },
					credential: config.apiKey,
				});
				const data = await readJson(response);
				if (!response.ok) throw toError(response.status, data);
				if (data?.key) {
					virtualKeyCache.set(cacheKey(customerId), data.key);
				}
				return data as {
					key: string;
					customer_id: string;
					created: boolean;
				};
			},
		},

		models: {
			list: async () => {
				const response = await request({
					path: "/v1/catalog",
					method: "GET",
					credential: config.apiKey,
				});
				const data = await readJson(response);
				if (!response.ok) throw toError(response.status, data);
				return data as Catalog;
			},
		},
	};
}

/** The end user being billed.  Without it there is nothing to charge. */
const requireUser = (params: ChatCompletionRequest): string => {
	const user = params?.user;
	if (!user || typeof user !== "string") {
		throw new MeterPalError(
			"`user` is required — it is the id of the end user being billed.",
		);
	}
	return user;
};

const readJson = async (response: Response): Promise<any> => {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return { message: text };
	}
};

/**
 * Turn an API answer into the error the caller can act on.
 *
 * The code decides when the status is ambiguous (404 is either an unknown
 * model or an unknown end user); the status decides otherwise.
 */
const toError = (status: number, body: any): MeterPalError => {
	const error = body?.error ?? {};
	const code: string | undefined = error.code ?? body?.code;
	const message: string =
		error.message ?? body?.message ?? `MeterPal request failed (${status})`;

	switch (code) {
		case "model_not_enabled":
			return new ModelNotEnabledError(message, { status, code, body });
		case "model_not_found":
			return new ModelNotFoundError(message, { status, code, body });
		case "customer_not_found":
			return new CustomerNotFoundError(message, {
				status,
				code,
				body,
				customerId: body?.error?.customer_id,
			});
	}

	switch (status) {
		case 401:
			return new AuthenticationError(message, { status, code, body });
		case 402:
			return new InsufficientBalanceError(message, {
				status,
				code,
				body,
				customerId: error.customer_id,
				balance: error.balance,
				requiredCredits: error.required_credits,
			});
		case 403:
			return new ModelNotEnabledError(message, { status, code, body });
		case 404:
			return new ModelNotFoundError(message, { status, code, body });
		case 429:
			return new RateLimitError(message, { status, code, body });
		default:
			return new APIError(message, { status, code, body });
	}
};

/** Give the paywall its way out: the checkout it can open. */
const decorate = (
	error: MeterPalError,
	{
		customerId,
		createCheckout,
	}: {
		customerId: string;
		createCheckout: (opts: {
			customerId: string;
			productId?: string;
			returnUrl?: string;
		}) => Promise<TopUpResult>;
	},
): MeterPalError => {
	if (error instanceof InsufficientBalanceError) {
		error.customerId = error.customerId ?? customerId;
		error.topUp = async (options: TopUpOptions = {}) =>
			await createCheckout({
				customerId: error.customerId ?? customerId,
				productId: options.productId,
				returnUrl: options.returnUrl,
			});
	}
	return error;
};

/**
 * Read a Server-Sent Events stream.
 *
 * Yields every `data:` payload except the `[DONE]` terminator.  The final
 * payload MeterPal sends is the charge for the call, which arrives as
 * `{ "meterpal": { ... } }`.
 */
async function* readSse(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split("\n\n");
			buffer = parts.pop() ?? "";

			for (const part of parts) {
				const payload = sseData(part);
				if (payload === null) continue;
				if (payload === "[DONE]") return;
				yield payload as Record<string, unknown>;
			}
		}

		buffer += decoder.decode();
		const payload = sseData(buffer);
		if (payload && payload !== "[DONE]") {
			yield payload as Record<string, unknown>;
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// already released
		}
	}
}

/** The `data:` payload of one SSE event, or null when there is none. */
const sseData = (event: string): Record<string, unknown> | string | null => {
	const lines = event.split("\n");
	const data = lines
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n");
	if (!data) return null;
	if (data === "[DONE]") return data;
	try {
		return JSON.parse(data);
	} catch {
		return null;
	}
};

export type { MeterpalBlock };
