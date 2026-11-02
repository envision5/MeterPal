import { describe, it, expect, vi } from "vitest";
import { createMeterPal } from "./client";
import {
	AuthenticationError,
	CustomerNotFoundError,
	InsufficientBalanceError,
	ModelNotEnabledError,
	ModelNotFoundError,
	RateLimitError,
} from "./errors";

const API_KEY = "am_sk_test_key";
const BASE_URL = "https://meterpal.test";

/** A fetch that answers with one canned response. */
const respondWith = (
	status: number,
	body: unknown,
	onRequest?: (url: string, init?: RequestInit) => void,
) => {
	return vi.fn(async (url: string, init?: RequestInit) => {
		onRequest?.(url, init);
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
};

describe("createMeterPal", () => {
	it("refuses to be built without a key", () => {
		expect(() => createMeterPal({ apiKey: "" })).toThrow(/apiKey/);
	});

	it("requires the end user being billed", async () => {
		const meterpal = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: respondWith(200, {}),
		});
		await expect(
			meterpal.chat.completions.create({
				model: "custom/demo-gpt",
				messages: [{ role: "user", content: "hi" }],
			}),
		).rejects.toThrow(/user/);
	});

	it("mints a per-customer virtual key once, then reuses it", async () => {
		const seen: string[] = [];
		const meterpal = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: respondWith(
				200,
				{ key: "sk-virtual", customer_id: "cus_1", created: true },
				(url) => seen.push(url),
			) as unknown as typeof fetch,
		});

		await meterpal.chat.completions.create({
			model: "custom/demo-gpt",
			messages: [{ role: "user", content: "hi" }],
			user: "cus_1",
		});
		await meterpal.chat.completions.create({
			model: "custom/demo-gpt",
			messages: [{ role: "user", content: "again" }],
			user: "cus_1",
		});

		// One key mint, two chat calls.
		expect(seen.filter((u) => u.endsWith("/v1/keys"))).toHaveLength(1);
		expect(seen.filter((u) => u.endsWith("/v1/chat/completions"))).toHaveLength(2);
	});

	it("returns the meterpal block with the completion", async () => {
		const meterpal = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: respondWith(200, {
				id: "chatcmpl-1",
				choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
				usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
				meterpal: {
					credits_charged: 0.0067,
					balance_after: 99.99,
					customer_id: "cus_1",
					model_id: "custom/demo-gpt",
					input_tokens: 3,
					output_tokens: 5,
				},
			}),
		});

		const completion = await meterpal.chat.completions.create({
			model: "custom/demo-gpt",
			messages: [{ role: "user", content: "hi" }],
			user: "cus_1",
		});

		expect(completion.meterpal.credits_charged).toBe(0.0067);
		expect(completion.meterpal.balance_after).toBe(99.99);
	});

	it("maps a 401 to an authentication error", async () => {
		const meterpal = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: respondWith(401, { message: "Invalid secret key" }),
		});
		await expect(
			meterpal.chat.completions.create({
				model: "custom/demo-gpt",
				messages: [{ role: "user", content: "hi" }],
				user: "cus_1",
			}),
		).rejects.toBeInstanceOf(AuthenticationError);
	});

	it("maps a 402 to a paywall error that can open a checkout", async () => {
		const meterpal = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: respondWith(402, {
				error: {
					type: "insufficient_balance",
					code: "insufficient_balance",
					message: "insufficient_balance",
					customer_id: "cus_1",
					balance: 0,
					required_credits: 0.5,
				},
			}),
		});

		const error = await meterpal.chat.completions
			.create({
				model: "custom/demo-gpt",
				messages: [{ role: "user", content: "hi" }],
				user: "cus_1",
			})
			.catch((e) => e);

		expect(error).toBeInstanceOf(InsufficientBalanceError);
		expect(error.customerId).toBe("cus_1");
		expect(error.balance).toBe(0);
		expect(error.requiredCredits).toBe(0.5);
		expect(typeof error.topUp).toBe("function");
	});

	it("maps a disabled model and an unknown model apart", async () => {
		const disabled = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: respondWith(403, {
				message: "not enabled",
				code: "model_not_enabled",
			}),
		});
		await expect(
			disabled.chat.completions.create({
				model: "openai/gpt-4o-mini",
				messages: [{ role: "user", content: "hi" }],
				user: "cus_1",
			}),
		).rejects.toBeInstanceOf(ModelNotEnabledError);

		const unknown = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: respondWith(404, {
				message: "not in catalog",
				code: "model_not_found",
			}),
		});
		await expect(
			unknown.chat.completions.create({
				model: "nope",
				messages: [{ role: "user", content: "hi" }],
				user: "cus_1",
			}),
		).rejects.toBeInstanceOf(ModelNotFoundError);
	});

	it("maps a 429 to a rate limit error", async () => {
		const meterpal = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: respondWith(429, { message: "slow down" }),
		});
		await expect(
			meterpal.chat.completions.create({
				model: "custom/demo-gpt",
				messages: [{ role: "user", content: "hi" }],
				user: "cus_1",
			}),
		).rejects.toBeInstanceOf(RateLimitError);
	});

	it("creates the end user when they do not exist yet", async () => {
		const calls: string[] = [];
		let minted = false;
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			calls.push(url);
			if (url.endsWith("/v1/keys")) {
				if (!minted) {
					minted = true;
					return new Response(
						JSON.stringify({ message: "no such customer" }),
						{ status: 404 },
					);
				}
				return new Response(
					JSON.stringify({ key: "sk-virtual", customer_id: "cus_new" }),
					{ status: 200 },
				);
			}
			if (url.endsWith("/v1/customers")) {
				return new Response(JSON.stringify({ id: "cus_new" }), { status: 200 });
			}
			return new Response(
				JSON.stringify({ id: "chatcmpl-1", meterpal: { credits_charged: 0 } }),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const meterpal = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: fetchImpl,
		});

		const completion = await meterpal.chat.completions.create({
			model: "custom/demo-gpt",
			messages: [{ role: "user", content: "hi" }],
			user: "cus_new",
		});

		expect(completion.id).toBe("chatcmpl-1");
		expect(calls.some((c) => c.endsWith("/v1/customers"))).toBe(true);
	});

	it("does not create the end user when autoCreateCustomer is off", async () => {
		const calls: string[] = [];
		const fetchImpl = vi.fn(async (url: string) => {
			calls.push(url);
			return new Response(
				JSON.stringify({ message: "no such customer", code: "customer_not_found" }),
				{ status: 404 },
			);
		}) as unknown as typeof fetch;

		const meterpal = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: fetchImpl,
			autoCreateCustomer: false,
		});

		await expect(
			meterpal.chat.completions.create({
				model: "custom/demo-gpt",
				messages: [{ role: "user", content: "hi" }],
				user: "cus_missing",
			}),
		).rejects.toBeInstanceOf(CustomerNotFoundError);
		expect(calls.some((c) => c.endsWith("/v1/customers"))).toBe(false);
	});

	it("reads a stream of chunks and the charge at the end", async () => {
		const sse = [
			'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hel"}}]}',
			'data: {"id":"1","choices":[{"index":0,"delta":{"content":"lo"}}]}',
			'data: {"meterpal":{"credits_charged":0.01,"balance_after":9.99,"customer_id":"cus_1"}}',
			"data: [DONE]",
			"",
		].join("\n\n");

		const meterpal = createMeterPal({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			fetch: (async () =>
				new Response(sse, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				})) as unknown as typeof fetch,
		});

		let text = "";
		let charge: number | null = null;
		for await (const chunk of meterpal.chat.completions.stream({
			model: "custom/demo-gpt",
			messages: [{ role: "user", content: "hi" }],
			user: "cus_1",
		})) {
			text += chunk.choices?.[0]?.delta?.content ?? "";
			if (chunk.meterpal) charge = chunk.meterpal.credits_charged;
		}

		expect(text).toBe("Hello");
		expect(charge).toBe(0.01);
	});
});
