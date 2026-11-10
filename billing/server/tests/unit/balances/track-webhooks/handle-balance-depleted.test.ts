import { expect, test } from "bun:test";
import { contexts } from "@tests/utils/fixtures/db/contexts.js";
import { customerEntitlements } from "@tests/utils/fixtures/db/customerEntitlements.js";
import { customerProducts } from "@tests/utils/fixtures/db/customerProducts.js";
import { customers } from "@tests/utils/fixtures/db/customers.js";
import {
	featureBalance,
	handleBalanceDepleted,
	isDepletion,
} from "@/internal/balances/trackWebhooks/handleBalanceDepleted.js";

/**
 * The zero-balance signal.
 *
 * An agent that manages a customer's wallet has to learn that the credits
 * ran out the moment it happens — not the next time the customer spends and
 * gets refused.  The core knows the exact transition (the balance before and
 * after a deduction), so that is where the signal is produced, and it is
 * only produced for customers who gave an agent a mandate in the first
 * place.
 */
const MANDATE = {
	enabled: true,
	max_per_purchase: 200,
	monthly_budget: 10000,
	auto_approve_below: 200,
};

const buildCustomer = ({
	balance,
	metadata = {},
}: {
	balance: number;
	metadata?: Record<string, unknown>;
}) => {
	const entitlement = customerEntitlements.create({
		id: "cus_ent_tokens",
		customerProductId: "cus_prod_test",
		featureId: "ai_tokens",
		featureName: "AI Tokens",
		allowance: 100,
		balance,
	});
	const plan = customerProducts.create({
		id: "cus_prod_test",
		productId: "prod_test",
		customerEntitlements: [entitlement],
	});
	const customer = customers.create({ customerProducts: [plan] });
	customer.metadata = metadata;
	return {
		customer,
		feature: plan.customer_entitlements[0].entitlement.feature,
	};
};

/** A db stub that records the metadata write instead of hitting Postgres. */
const recordingDb = () => {
	const writes: unknown[] = [];
	const db = {
		update: () => ({
			set: (values: unknown) => {
				writes.push(values);
				return { where: async () => undefined };
			},
		}),
	};
	return { db, writes };
};

test("isDepletion is the positive-to-empty transition, not the empty state", () => {
	expect(isDepletion({ oldBalance: 100, newBalance: 0 })).toBe(true);
	expect(isDepletion({ oldBalance: 100, newBalance: -5 })).toBe(true);
	// Already empty before the deduction: nothing new happened.
	expect(isDepletion({ oldBalance: 0, newBalance: 0 })).toBe(false);
	// Still has credits: not a depletion.
	expect(isDepletion({ oldBalance: 100, newBalance: 40 })).toBe(false);
});

test("featureBalance sums the customer's entitlements for that feature", () => {
	const { customer, feature } = buildCustomer({ balance: 100 });
	expect(featureBalance({ fullCus: customer, featureId: feature.id })).toBe(100);
});

test("a customer with a mandate gets the depletion recorded", async () => {
	const { customer, feature } = buildCustomer({
		balance: 0,
		metadata: { buyer_agent_mandate: MANDATE },
	});
	const old = buildCustomer({ balance: 100 }).customer;

	const { db, writes } = recordingDb();
	const ctx = contexts.create({});
	ctx.db = db as never;

	await handleBalanceDepleted({
		ctx,
		oldFullCus: old,
		newFullCus: customer,
		feature,
	});

	expect(writes.length).toBe(1);
});

test("a customer without a mandate is left alone", async () => {
	const { customer, feature } = buildCustomer({ balance: 0 });
	const old = buildCustomer({ balance: 100 }).customer;

	const { db, writes } = recordingDb();
	const ctx = contexts.create({});
	ctx.db = db as never;

	await handleBalanceDepleted({
		ctx,
		oldFullCus: old,
		newFullCus: customer,
		feature,
	});

	expect(writes.length).toBe(0);
});

test("a balance that stays positive records nothing", async () => {
	const { customer, feature } = buildCustomer({
		balance: 40,
		metadata: { buyer_agent_mandate: MANDATE },
	});
	const old = buildCustomer({ balance: 100 }).customer;

	const { db, writes } = recordingDb();
	const ctx = contexts.create({});
	ctx.db = db as never;

	await handleBalanceDepleted({
		ctx,
		oldFullCus: old,
		newFullCus: customer,
		feature,
	});

	expect(writes.length).toBe(0);
});
