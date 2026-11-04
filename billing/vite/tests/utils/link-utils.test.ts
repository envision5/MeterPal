import { describe, expect, test } from "bun:test";
import {
	isSafeCustomButtonUrl,
	resolveCustomButtonUrl,
} from "@/utils/linkUtils";

describe("resolveCustomButtonUrl", () => {
	test("replaces the customer id token", () => {
		expect(
			resolveCustomButtonUrl("https://example.com/c/{customerId}", {
				id: "cus_123",
			}),
		).toBe("https://example.com/c/cus_123");
	});

	test("replaces the customer email token and encodes it", () => {
		expect(
			resolveCustomButtonUrl("https://example.com/?e={customerEmail}", {
				email: "a+b@example.com",
			}),
		).toBe("https://example.com/?e=a%2Bb%40example.com");
	});

	test("keeps mailto recipients unencoded", () => {
		expect(
			resolveCustomButtonUrl("mailto:{customerEmail}", {
				email: "a+b@example.com",
			}),
		).toBe("mailto:a+b@example.com");
	});

	test("an unknown customer value resolves to an empty string", () => {
		expect(
			resolveCustomButtonUrl("https://example.com/{customerId}", {}),
		).toBe("https://example.com/");
	});
});

describe("isSafeCustomButtonUrl", () => {
	test("accepts http and https", () => {
		expect(isSafeCustomButtonUrl("https://example.com")).toBe(true);
		expect(isSafeCustomButtonUrl("http://example.com")).toBe(true);
	});

	test("rejects javascript urls", () => {
		expect(isSafeCustomButtonUrl("javascript:alert(1)")).toBe(false);
	});

	test("rejects unparseable urls", () => {
		expect(isSafeCustomButtonUrl("not a url")).toBe(false);
	});
});
