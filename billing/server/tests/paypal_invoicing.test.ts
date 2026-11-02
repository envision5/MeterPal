// tests/paypal_invoicing.test.ts
//
// Unit tests for the PayPal Invoicing API v2 wrappers. Run with:
//   bun test ./tests/paypal_invoicing.test.ts
//
// A fake client is passed in — no network, no credentials.

import { describe, it, expect, beforeEach } from "bun:test";
import type { PaypalClient } from "../src/external/paypal/paypalClient.js";

type CapturedCall = { path: string; init: Record<string, any> };
const calls: CapturedCall[] = [];

// The PayPal client is per-org now, so the tests pass a fake one in
// instead of mocking a module-level fetch.
const client = {
	baseUrl: "https://api-m.sandbox.paypal.com",
	fromOrg: true,
	fetch: async (path: string, init: Record<string, any> = {}) => {
		calls.push({ path, init });
		return {
			id: "INV2-XYZ",
			status: "DRAFT",
			detail: { reference: "mp:demo-customer", currency_code: "USD" },
			links: [],
		};
	},
	getAccessToken: async () => "test-token",
} as unknown as PaypalClient;

const { createInvoice, sendInvoice, getInvoice, listInvoices } = await import(
	"../src/external/paypal/invoicing.js"
);

beforeEach(() => {
	calls.length = 0;
});

const last = () => calls[calls.length - 1];

describe("createInvoice", () => {
	it("POSTs a USD invoice with our customer reference and matching totals", async () => {
		await createInvoice({
			client,
			reference: "mp:demo-customer",
			recipientEmail: "buyer@sandbox.example.com",
			billerBusinessName: "MeterPal Demo",
			itemName: "AI usage overage",
			amountUsd: 12.5,
			memo: "overage for June",
		});
		expect(last().path).toBe("/v2/invoicing/invoices");
		expect(last().init.method).toBe("POST");
		const body = JSON.parse(last().init.body);
		expect(body.detail.reference).toBe("mp:demo-customer");
		expect(body.detail.currency_code).toBe("USD");
		expect(body.invoicer.business_name).toBe("MeterPal Demo");
		expect(body.primary_recipients[0].billing_info.email_address).toBe(
			"buyer@sandbox.example.com",
		);
		expect(body.items).toHaveLength(1);
		expect(body.items[0].unit_amount).toEqual({
			currency_code: "USD",
			value: "12.50",
		});
		expect(body.amount.breakdown.item_total).toEqual({
			currency_code: "USD",
			value: "12.50",
		});
	});

	it("passes an idempotency key through to PayPal-Request-Id", async () => {
		await createInvoice({
			client,
			reference: "mp:c1",
			recipientEmail: "a@b.c",
			itemName: "overage",
			amountUsd: 1,
			idempotencyKey: "mp-inv-123",
		});
		expect(last().init.idempotencyKey).toBe("mp-inv-123");
	});
});

describe("sendInvoice", () => {
	it("POSTs to the send endpoint with return=representation", async () => {
		await sendInvoice(client, "INV2-XYZ");
		expect(last().path).toBe("/v2/invoicing/invoices/INV2-XYZ/send");
		expect(last().init.method).toBe("POST");
		expect(last().init.headers.Prefer).toBe("return=representation");
	});
});

describe("getInvoice / listInvoices", () => {
	it("GETs an invoice by id", async () => {
		await getInvoice(client, "INV2-XYZ");
		expect(last().path).toBe("/v2/invoicing/invoices/INV2-XYZ");
		expect(last().init.method).toBe("GET");
	});

	it("lists invoices with paging params", async () => {
		await listInvoices(client, { page: 2, pageSize: 10 });
		expect(last().path).toContain("/v2/invoicing/invoices?");
		expect(last().path).toContain("page=2");
		expect(last().path).toContain("page_size=10");
	});
});
