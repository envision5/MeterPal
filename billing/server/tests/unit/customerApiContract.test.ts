// billing/server/tests/unit/customerApiContract.test.ts
//
// The customer payload is a CONTRACT with the client SDK (autumn-js), which
// validates every response against a fixed schema and rejects the WHOLE
// payload when a single required key is missing.
//
// The key that matters: `stripe_id`.  MeterPal is PayPal-native and has no
// Stripe ids, so the field is always null — but the client schema requires
// the KEY to be present.  When it was missing, the client silently rejected
// every customer read: `useCustomer()` returned nothing, so the plan card
// could not tell which plan was current, and the demo showed a customer
// paying for MeterPal Pro while the UI showed no plan and no new credits.
//
// These tests lock that contract:
//   1. the schema REQUIRES stripe_id, so a builder that forgets to set it
//      fails loudly at parse time instead of shipping a payload the client
//      rejects
//   2. a realistic customer payload keeps the key through the parse (zod
//      strips unknown keys, so a field missing from the schema disappears)
//   3. the payload names the customer's plan, which is what the client turns
//      into "the current plan"
//
// Run with: bun test ./tests/unit/customerApiContract.test.ts

import { describe, expect, test } from "bun:test";
import {
	ApiCustomerV5Schema,
	BaseApiCustomerSchema,
} from "@autumn/shared";

/** A customer as the API returns it — trimmed to the fields under test. */
const customerPayload = () => ({
	id: "demo-customer",
	name: "Ada Lovelace",
	email: "ada@example.com",
	created_at: 1794062950536,
	fingerprint: null,
	// Always null: MeterPal bills through PayPal, not Stripe.
	stripe_id: null,
	env: "sandbox" as const,
	metadata: {},
	send_email_receipts: false,
	billing_controls: {},
	subscriptions: [
		{
			id: "cus_prod_123",
			plan_id: "pro",
			auto_enable: false,
			add_on: false,
			status: "active" as const,
			past_due: false,
			canceled_at: null,
			expires_at: null,
			trial_ends_at: null,
			started_at: 1794269731845,
			current_period_start: null,
			current_period_end: null,
			quantity: 1,
			scope: "customer" as const,
		},
	],
	purchases: [],
	licenses: [],
	balances: {},
	flags: {},
});

describe("customer payload contract", () => {
	test("the schema requires stripe_id", () => {
		// Without it the client SDK rejects the entire payload, so the field
		// must be REQUIRED here: a builder that forgets it has to blow up at
		// parse time rather than ship a silently-rejected response.
		const { stripe_id: _stripeId, ...withoutStripeId } = customerPayload();
		expect(() => BaseApiCustomerSchema.parse(withoutStripeId)).toThrow();
		expect(
			BaseApiCustomerSchema.safeParse(withoutStripeId).success,
		).toBe(false);
	});

	test("stripe_id survives the customer parse", () => {
		const parsed = ApiCustomerV5Schema.parse(customerPayload());
		expect("stripe_id" in parsed).toBe(true);
		expect(parsed.stripe_id).toBeNull();
	});

	test("the payload names the customer's plan", () => {
		// This is what the client turns into "the current plan" — the plan
		// card marks the active subscription, and the demo shows the plan
		// name in the header.
		const parsed = ApiCustomerV5Schema.parse(customerPayload());
		expect(parsed.subscriptions.length).toBe(1);
		expect(parsed.subscriptions[0].plan_id).toBe("pro");
		expect(parsed.subscriptions[0].status).toBe("active");
	});
});
