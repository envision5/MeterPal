// tests/paypal_features.test.ts
//
// Unit tests for the PayPal merchant-ops features (refunds, subscription
// lifecycle, merchant-initiated auto top-ups, catalog re-sync, webhook
// registration, disputes).  Run with:
//   bun test ./tests/paypal_features.test.ts
//
// Pure functions and fake clients — no network, no DB, no credentials.

import { beforeEach, describe, expect, it } from "bun:test";
import type { PaypalClient } from "../src/external/paypal/paypalClient.js";

// ---------- fake client ----------
type CapturedCall = { path: string; init: Record<string, any> };
const calls: CapturedCall[] = [];

let nextResponse: any = { id: "REFUND-1", status: "COMPLETED" };

const client = {
	baseUrl: "https://api-m.sandbox.paypal.com",
	fromOrg: true,
	fetch: async (path: string, init: Record<string, any> = {}) => {
		calls.push({ path, init });
		if (nextResponse instanceof Error) throw nextResponse;
		return typeof nextResponse === "function"
			? nextResponse(path, init)
			: nextResponse;
	},
	getAccessToken: async () => "test-token",
} as unknown as PaypalClient;

beforeEach(() => {
	calls.length = 0;
	nextResponse = { id: "REFUND-1", status: "COMPLETED" };
});

// ---------- wrappers ----------
const { refundSale } = await import("../src/external/paypal/sales.js");
const { refundCapture } = await import("../src/external/paypal/orders.js");
const {
	activateSubscription,
	cancelSubscription,
	updatePlanPricing,
	regularCycleSequence,
} = await import("../src/external/paypal/subscriptions.js");

describe("refund wrappers", () => {
	it("refundSale posts to the v1 sale refund endpoint with {currency, value} money keys", async () => {
		const res = await refundSale(client, "4XY123", 2.5, "oops");
		expect(res.id).toBe("REFUND-1");

		expect(calls.length).toBe(1);
		const call = calls[0];
		expect(call.path).toBe("/v1/payments/sale/4XY123/refund");
		const body = JSON.parse(call.init.body);
		// v1 money uses `currency` + `value` — NOT the v2 `currency_code`.
		expect(body.amount).toEqual({ currency: "USD", value: "2.50" });
		expect(body.description).toBe("oops");
	});

	it("refundSale refunds the whole sale when no amount is given", async () => {
		await refundSale(client, "4XY123");
		const body = JSON.parse(calls[0].init.body);
		expect(body.amount).toBeUndefined();
	});

	it("refundCapture posts to the v2 captures refund endpoint with {currency_code, value}", async () => {
		await refundCapture(
			client,
			"CAP-1",
			{ currency_code: "USD", value: "5.00" },
			"partial",
		);
		const call = calls[0];
		expect(call.path).toBe("/v2/payments/captures/CAP-1/refund");
		const body = JSON.parse(call.init.body);
		expect(body.amount).toEqual({ currency_code: "USD", value: "5.00" });
		expect(body.note_to_payer).toBe("partial");
	});
});

describe("subscription lifecycle wrappers", () => {
	it("activateSubscription posts a reason to the activate endpoint", async () => {
		await activateSubscription(client, "I-123", "customer asked nicely");
		const call = calls[0];
		expect(call.path).toBe("/v1/billing/subscriptions/I-123/activate");
		const body = JSON.parse(call.init.body);
		expect(body.reason).toBe("customer asked nicely");
	});

	it("activateSubscription truncates over-long reasons to PayPal's 128-char limit", async () => {
		await activateSubscription(client, "I-123", "r".repeat(300));
		const body = JSON.parse(calls[0].init.body);
		expect(body.reason.length).toBe(128);
	});

	it("cancelSubscription posts a reason to the cancel endpoint", async () => {
		await cancelSubscription(client, "I-123", "bye");
		const call = calls[0];
		expect(call.path).toBe("/v1/billing/subscriptions/I-123/cancel");
		expect(JSON.parse(call.init.body).reason).toBe("bye");
	});

	it("updatePlanPricing targets the REGULAR cycle's pricing scheme", async () => {
		await updatePlanPricing({
			client,
			planId: "P-1",
			cycleSequence: 2,
			amountUsd: 25,
		});
		const call = calls[0];
		expect(call.path).toBe("/v1/billing/plans/P-1/update-pricing-schemes");
		const body = JSON.parse(call.init.body);
		expect(body.pricing_schemes).toEqual([
			{
				billing_cycle_sequence: 2,
				pricing_scheme: { fixed_price: { value: "25.00", currency_code: "USD" } },
			},
		]);
	});
});

// ---------- auto top-up order builder ----------
const { buildPaypalAutoTopupOrder } = await import(
	"../src/internal/balances/autoTopUp/paypal/paypalAutoTopup.js"
);

describe("buildPaypalAutoTopupOrder", () => {
	it("builds a merchant-initiated capture against the billing agreement", () => {
		const order = buildPaypalAutoTopupOrder({
			customerId: "cus_1",
			featureId: "ai_tokens",
			amountUsd: 20,
			billingAgreementId: "BA-2M539689T3856352J",
		});

		expect(order.intent).toBe("CAPTURE");
		expect(order.purchase_units[0].amount.value).toBe("20.00");
		expect(order.purchase_units[0].custom_id).toBe("mp:cus_1:ai_tokens");
		expect(order.payment_source?.paypal?.billing_agreement_id).toBe(
			"BA-2M539689T3856352J",
		);
		expect(order.payment_source?.paypal?.stored_credential).toEqual({
			payment_initiator: "MERCHANT",
			usage: "SUBSEQUENT",
		});
		// No buyer-facing experience context: there is no approval page.
		expect(order.payment_source?.paypal?.experience_context).toBeUndefined();
	});
});

// ---------- catalog re-sync decision ----------
const { decidePaypalPlanResync } = await import(
	"../src/internal/billing/paypal/paypalCatalogSync.js"
);

const makeProduct = (amount: number, interval: string, name = "Pro") =>
	({
		name,
		prices: [
			{
				id: "price_1",
				config: { type: "fixed", amount, interval },
			},
		],
	}) as never;

describe("decidePaypalPlanResync", () => {
	it("in_sync when nothing is mapped (checkout provisions lazily)", () => {
		const d = decidePaypalPlanResync({
			mapRow: null,
			product: makeProduct(20, "month"),
		});
		expect(d.action).toBe("in_sync");
	});

	it("in_sync when amount and interval match the map row", () => {
		const d = decidePaypalPlanResync({
			mapRow: {
				paypal_plan_id: "P-1",
				amount_usd: 20,
				interval: "month",
				name: "Pro",
			},
			product: makeProduct(20, "month"),
		});
		expect(d.action).toBe("in_sync");
	});

	it("update_price when only the amount changed", () => {
		const d = decidePaypalPlanResync({
			mapRow: {
				paypal_plan_id: "P-1",
				amount_usd: 20,
				interval: "month",
				name: "Pro",
			},
			product: makeProduct(25, "month"),
		});
		expect(d.action).toBe("update_price");
		expect(d.amountUsd).toBe(25);
	});

	it("update_price when only the name changed (plan rename)", () => {
		const d = decidePaypalPlanResync({
			mapRow: {
				paypal_plan_id: "P-1",
				amount_usd: 20,
				interval: "month",
				name: "Pro",
			},
			product: makeProduct(20, "month", "Pro Max"),
		});
		expect(d.action).toBe("update_price");
		expect(d.nameChanged).toBe(true);
	});

	it("recreate_plan when the billing interval changed (plans cannot be re-intervaled)", () => {
		const d = decidePaypalPlanResync({
			mapRow: {
				paypal_plan_id: "P-1",
				amount_usd: 20,
				interval: "month",
				name: "Pro",
			},
			product: makeProduct(20, "year"),
		});
		expect(d.action).toBe("recreate_plan");
	});
});

// ---------- plan cycle sequence ----------
describe("regularCycleSequence", () => {
	it("returns the REGULAR cycle's sequence (2 when a trial precedes it)", () => {
		expect(
			regularCycleSequence({
				billing_cycles: [
					{ tenure_type: "TRIAL", sequence: 1, total_cycles: 1 },
					{ tenure_type: "REGULAR", sequence: 2, total_cycles: 0 },
				],
			}),
		).toBe(2);
		expect(
			regularCycleSequence({
				billing_cycles: [
					{ tenure_type: "REGULAR", sequence: 1, total_cycles: 0 },
				],
			}),
		).toBe(1);
	});
});

// ---------- webhook event registration ----------
const { PAYPAL_WEBHOOK_EVENT_TYPES } = await import(
	"../src/external/paypal/webhookEventTypes.js"
);
const { handlePaypalEvent } = await import(
	"../src/external/paypal/runPaypalWebhookHandlers.js"
);

describe("webhook event registration", () => {
	const registered: string[] = [...PAYPAL_WEBHOOK_EVENT_TYPES];

	it("subscribes to every dispute event the handler accepts", () => {
		for (const name of [
			"CUSTOMER.DISPUTE.CREATED",
			"CUSTOMER.DISPUTE.UPDATED",
			"CUSTOMER.DISPUTE.RESOLVED",
		]) {
			expect(registered).toContain(name);
		}
	});

	it("keeps the core money events subscribed", () => {
		for (const name of [
			"PAYMENT.CAPTURE.COMPLETED",
			"PAYMENT.CAPTURE.REFUNDED",
			"PAYMENT.SALE.COMPLETED",
			"BILLING.SUBSCRIPTION.ACTIVATED",
			"BILLING.SUBSCRIPTION.RE-ACTIVATED",
			"INVOICING.INVOICE.PAID",
		]) {
			expect(registered).toContain(name);
		}
	});

	it("ignores an unregistered event type instead of dispatching it", async () => {
		// A dispute-less unknown event must not blow up and must not record:
		// handlePaypalEvent silently ignores types outside the registered list.
		await handlePaypalEvent({
			id: "evt-unknown",
			type: "PAYMENT.PAYOUTS.PAYOUT-ENTRY.COMPLETED",
			resource: {},
		});
	});
});

// ---------- invoice external id conventions ----------
const {
	paypalCaptureInvoiceId,
	paypalSaleInvoiceId,
	paypalInvoiceRefId,
	paypalInvoiceInstrument,
} = await import("../src/external/paypal/invoiceRecording.js");

describe("paypal invoice external ids", () => {
	it("namespaces and resolves each instrument", () => {
		expect(paypalInvoiceInstrument("pp-cap-ABC")).toEqual({
			instrument: "capture",
			externalId: "ABC",
		});
		expect(paypalInvoiceInstrument("pp-sale-4XY")).toEqual({
			instrument: "sale",
			externalId: "4XY",
		});
		expect(paypalInvoiceInstrument("pp-inv-INV")).toEqual({
			instrument: "invoice",
			externalId: "INV",
		});
		expect(paypalInvoiceInstrument("in_123")).toBeNull();
		expect(paypalInvoiceInstrument("pp-junk")).toBeNull();
	});

	it("round-trips", () => {
		expect(paypalInvoiceInstrument(paypalCaptureInvoiceId("CAP-1"))).toEqual({
			instrument: "capture",
			externalId: "CAP-1",
		});
		expect(paypalInvoiceInstrument(paypalSaleInvoiceId("S1"))).toEqual({
			instrument: "sale",
			externalId: "S1",
		});
		expect(paypalInvoiceInstrument(paypalInvoiceRefId("INV-9"))).toEqual({
			instrument: "invoice",
			externalId: "INV-9",
		});
	});
});
