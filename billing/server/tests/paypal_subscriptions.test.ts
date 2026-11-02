// tests/paypal_subscriptions.test.ts
//
// Unit tests for the PayPal catalog/subscriptions wrappers. Run with:
//   bun test ./tests/paypal_subscriptions.test.ts
//
// A fake client is passed in — no network, no credentials.
// Asserts request shapes (paths, bodies, idempotency headers) and the pure
// helpers (interval mapping, USD formatting, approval-link extraction).

import { describe, it, expect, beforeEach } from "bun:test";
import type { PaypalClient } from "../src/external/paypal/paypalClient.js";

type CapturedCall = { path: string; init: Record<string, any> };
const calls: CapturedCall[] = [];

let nextResponse: any = {
	id: "PP-PLAN-123",
	product_id: "PP-PROD-1",
	name: "Pro",
	status: "ACTIVE",
	links: [
		{ rel: "self", href: "https://api-m.sandbox.paypal.com/v1/billing/plans/PP-PLAN-123" },
		{ rel: "approve", href: "https://www.sandbox.paypal.com/approve" },
	],
};

// The PayPal client is per-org now, so the tests pass a fake one in
// instead of mocking a module-level fetch.
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

const {
	createCatalogProduct,
	createBillingPlan,
	createSubscription,
	getSubscription,
	reviseSubscription,
	suspendSubscription,
	cancelSubscription,
	createWebhook,
	intervalToPaypalUnit,
	toUsd,
	approvalLink,
	approvalTokenFromUrl,
} = await import("../src/external/paypal/subscriptions.js");
const { decidePaypalSubscriptionAction } = await import(
	"../src/internal/billing/paypal/decideSubscriptionAction.js"
);

beforeEach(() => {
	calls.length = 0;
	nextResponse = {
		id: "PP-PLAN-123",
		product_id: "PP-PROD-1",
		name: "Pro",
		status: "ACTIVE",
		links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/approve" }],
	};
});

const last = () => calls[calls.length - 1];

describe("intervalToPaypalUnit", () => {
	it("maps month/week/year directly", () => {
		expect(intervalToPaypalUnit("month")).toBe("MONTH");
		expect(intervalToPaypalUnit("week")).toBe("WEEK");
		expect(intervalToPaypalUnit("year")).toBe("YEAR");
	});
	it("maps unsupported intervals to the closest unit (MONTH)", () => {
		expect(intervalToPaypalUnit("quarter")).toBe("MONTH");
		expect(intervalToPaypalUnit("semi_annual")).toBe("MONTH");
		expect(intervalToPaypalUnit("one_off")).toBe("MONTH");
	});
});

describe("toUsd", () => {
	it("formats dollars as a 2-decimal string", () => {
		expect(toUsd(20)).toBe("20.00");
		expect(toUsd(7.5)).toBe("7.50");
		expect(toUsd(0)).toBe("0.00");
	});
});

describe("approvalLink", () => {
	it("extracts the approve link", () => {
		expect(
			approvalLink([
				{ rel: "self", href: "https://self" },
				{ rel: "approve", href: "https://approve" },
			]),
		).toBe("https://approve");
	});
	it("falls back to payer-action (subscriptions v1 sometimes returns it)", () => {
		expect(
			approvalLink([{ rel: "payer-action", href: "https://payer-action" }]),
		).toBe("https://payer-action");
	});
	it("returns null when absent", () => {
		expect(approvalLink([{ rel: "self", href: "https://self" }])).toBeNull();
		expect(approvalLink(undefined)).toBeNull();
	});
});

describe("approvalTokenFromUrl", () => {
	it("reads ba_token from a subscription approval link", () => {
		// PayPal returns subscriptions with ?ba_token=... — reading `token`
		// only left the BA->subscription mapping empty, so the buyer's
		// return from PayPal could not be resolved.
		expect(
			approvalTokenFromUrl(
				"https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-67Y71635N0909491C",
			),
		).toBe("BA-67Y71635N0909491C");
	});

	it("falls back to token for an order approval link", () => {
		expect(
			approvalTokenFromUrl(
				"https://www.sandbox.paypal.com/checkoutnow?token=1NV5590800020512H",
			),
		).toBe("1NV5590800020512H");
	});

	it("returns an empty string when there is no token", () => {
		expect(approvalTokenFromUrl("https://example.com/nope")).toBe("");
		expect(approvalTokenFromUrl("not a url")).toBe("");
	});
});

describe("createCatalogProduct", () => {
	it("POSTs a SERVICE/SOFTWARE product with an idempotency key", async () => {
		await createCatalogProduct({
			client,
			name: "MeterPal Pro",
			description: "Pro plan",
			sku: "org1:sandbox:pro",
			idempotencyKey: "mp-catprod-org1-sandbox-pro",
		});
		expect(last().path).toBe("/v1/catalog/products");
		expect(last().init.method).toBe("POST");
		const body = JSON.parse(last().init.body);
		expect(body.type).toBe("SERVICE");
		expect(body.category).toBe("SOFTWARE");
		expect(body.name).toBe("MeterPal Pro");
		expect(last().init.idempotencyKey).toBe("mp-catprod-org1-sandbox-pro");
	});
});

describe("createBillingPlan", () => {
	it("POSTs an ACTIVE plan with a REGULAR fixed-price cycle", async () => {
		await createBillingPlan({
			client,
			productId: "PP-PROD-1",
			name: "Pro",
			intervalUnit: "MONTH",
			amountUsd: 20,
			idempotencyKey: "mp-plan-org1-sandbox-pro",
		});
		expect(last().path).toBe("/v1/billing/plans");
		const body = JSON.parse(last().init.body);
		expect(body.product_id).toBe("PP-PROD-1");
		expect(body.status).toBe("ACTIVE");
		expect(body.billing_cycles).toHaveLength(1);
		const cycle = body.billing_cycles[0];
		expect(cycle.tenure_type).toBe("REGULAR");
		expect(cycle.frequency).toEqual({ interval_unit: "MONTH", interval_count: 1 });
		expect(cycle.total_cycles).toBe(0);
		expect(cycle.pricing_scheme.fixed_price).toEqual({
			value: "20.00",
			currency_code: "USD",
		});
		expect(last().init.idempotencyKey).toBe("mp-plan-org1-sandbox-pro");
	});

	it("prepends a TRIAL cycle when trialCycles > 0", async () => {
		await createBillingPlan({
			client,
			productId: "PP-PROD-1",
			name: "Pro",
			intervalUnit: "MONTH",
			amountUsd: 20,
			trialCycles: 1,
		});
		const body = JSON.parse(last().init.body);
		expect(body.billing_cycles).toHaveLength(2);
		expect(body.billing_cycles[0].tenure_type).toBe("TRIAL");
		expect(body.billing_cycles[0].pricing_scheme.fixed_price.value).toBe("0.00");
		expect(body.billing_cycles[1].sequence).toBe(2);
	});
});

describe("createSubscription", () => {
	it("POSTs a subscription with custom_id, NO_SHIPPING and SUBSCRIBE_NOW", async () => {
		const sub = await createSubscription({
			client,
			planId: "PP-PLAN-123",
			customId: "demo-customer",
			subscriberEmail: "buyer@example.com",
			returnUrl: "https://app.example.com/return",
			cancelUrl: "https://app.example.com/cancel",
			idempotencyKey: "mp-sub-abc",
		});
		expect(last().path).toBe("/v1/billing/subscriptions");
		const body = JSON.parse(last().init.body);
		expect(body.plan_id).toBe("PP-PLAN-123");
		expect(body.custom_id).toBe("demo-customer");
		expect(body.subscriber.email_address).toBe("buyer@example.com");
		expect(body.application_context.user_action).toBe("SUBSCRIBE_NOW");
		expect(body.application_context.shipping_preference).toBe("NO_SHIPPING");
		expect(body.application_context.return_url).toBe("https://app.example.com/return");
		expect(body.application_context.cancel_url).toBe("https://app.example.com/cancel");
		expect(last().init.idempotencyKey).toBe("mp-sub-abc");
		// the approve link is surfaced through the shared helper
		expect(approvalLink(sub.links)).toBe("https://www.sandbox.paypal.com/approve");
	});
});

describe("subscription lifecycle wrappers", () => {
	it("getSubscription GETs by id", async () => {
		await getSubscription(client, "I-123");
		expect(last().path).toBe("/v1/billing/subscriptions/I-123");
		expect(last().init.method).toBe("GET");
	});

	it("reviseSubscription POSTs the new plan", async () => {
		await reviseSubscription({
			client,
			subscriptionId: "I-123",
			planId: "PP-PLAN-NEW",
		});
		expect(last().path).toBe("/v1/billing/subscriptions/I-123/revise");
		const body = JSON.parse(last().init.body);
		expect(body.plan_id).toBe("PP-PLAN-NEW");
	});

	it("suspendSubscription / cancelSubscription POST with the right payload", async () => {
		await suspendSubscription(client, "I-123", "paused");
		expect(last().path).toBe("/v1/billing/subscriptions/I-123/suspend");
		expect(JSON.parse(last().init.body).note).toBe("paused");
		await cancelSubscription(client, "I-123", "superseded");
		expect(last().path).toBe("/v1/billing/subscriptions/I-123/cancel");
		// PayPal's CancelSubscriptionRequest takes `reason` (1..128 chars) —
		// sending `note` there is rejected as a malformed body.
		expect(JSON.parse(last().init.body).reason).toBe("superseded");
		expect(JSON.parse(last().init.body).note).toBeUndefined();
	});
});

describe("decidePaypalSubscriptionAction", () => {
	const base = {
		targetPlanId: "P-NEW",
		isFresh: true,
		hasApprovalLink: true,
	};

	it("treats an ACTIVE subscription on the same plan as already paid", () => {
		expect(
			decidePaypalSubscriptionAction({
				...base,
				paypalStatus: "ACTIVE",
				subscriptionPlanId: "P-NEW",
			}),
		).toEqual({ type: "already_paid" });
	});

	it("treats APPROVED like ACTIVE", () => {
		expect(
			decidePaypalSubscriptionAction({
				...base,
				paypalStatus: "APPROVED",
				subscriptionPlanId: "P-NEW",
			}),
		).toEqual({ type: "already_paid" });
	});

	it("revises an active subscription that is on another plan", () => {
		expect(
			decidePaypalSubscriptionAction({
				...base,
				paypalStatus: "ACTIVE",
				subscriptionPlanId: "P-OLD",
			}),
		).toEqual({ type: "revise" });
	});

	it("reuses the approval link of a fresh pending subscription on the same plan", () => {
		// PayPal reports a not-yet-approved subscription as APPROVAL_PENDING,
		// not CREATED — the old check never matched, so every click minted
		// another approvable subscription.
		expect(
			decidePaypalSubscriptionAction({
				...base,
				paypalStatus: "APPROVAL_PENDING",
				subscriptionPlanId: "P-NEW",
			}),
		).toEqual({ type: "reuse_approval" });
	});

	it("cancels and recreates a stale pending subscription", () => {
		expect(
			decidePaypalSubscriptionAction({
				...base,
				isFresh: false,
				paypalStatus: "APPROVAL_PENDING",
				subscriptionPlanId: "P-NEW",
			}),
		).toEqual({ type: "cancel_and_recreate" });
	});

	it("cancels and recreates a pending subscription for another plan", () => {
		expect(
			decidePaypalSubscriptionAction({
				...base,
				paypalStatus: "APPROVAL_PENDING",
				subscriptionPlanId: "P-OLD",
			}),
		).toEqual({ type: "cancel_and_recreate" });
	});

	it("creates a fresh subscription when there is none or it is dead", () => {
		for (const paypalStatus of [undefined, "CANCELLED", "SUSPENDED", "EXPIRED"]) {
			expect(
				decidePaypalSubscriptionAction({
					...base,
					paypalStatus,
					subscriptionPlanId: undefined,
				}),
			).toEqual({ type: "create" });
		}
	});
});

describe("createWebhook", () => {
	it("POSTs the event-type list for programmatic webhook registration", async () => {
		await createWebhook({
			client,
			url: "https://tunnel.example.com/webhooks/paypal",
			eventTypes: ["PAYMENT.CAPTURE.COMPLETED", "BILLING.SUBSCRIPTION.ACTIVATED"],
		});
		expect(last().path).toBe("/v1/notifications/webhooks");
		const body = JSON.parse(last().init.body);
		expect(body.url).toBe("https://tunnel.example.com/webhooks/paypal");
		expect(body.event_types).toEqual([
			{ name: "PAYMENT.CAPTURE.COMPLETED" },
			{ name: "BILLING.SUBSCRIPTION.ACTIVATED" },
		]);
	});
});
