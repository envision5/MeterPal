import { expect, test } from "bun:test";
import {
	ApiVersionClass,
	fullCustomerToFullSubject,
	LATEST_VERSION,
	OrgConfigSchema,
} from "@autumn/shared";
import { contexts } from "@tests/utils/fixtures/db/contexts.js";
import { customerEntitlements } from "@tests/utils/fixtures/db/customerEntitlements.js";
import { customerProducts } from "@tests/utils/fixtures/db/customerProducts.js";
import { customers } from "@tests/utils/fixtures/db/customers.js";
import { prepareFeatureDeductionV2 } from "@/internal/balances/utils/deductionV2/prepareFeatureDeductionV2.js";

/**
 * The floor a deduction may not pass.
 *
 * A prepaid entitlement that allows NO overage has no debt arrangement: the
 * customer has bought a fixed number of credits and nothing beyond them.  The
 * floor for such an entitlement is therefore zero -- a charge larger than the
 * balance is capped at the balance instead of driving it negative.  The next
 * request is refused at admission (the balance no longer covers the
 * reservation), which is the behaviour a credits wallet is supposed to have.
 */
const setup = ({
	usageAllowed,
	usageLimit = null,
}: {
	usageAllowed: boolean;
	usageLimit?: number | null;
}) => {
	const entitlement = customerEntitlements.create({
		id: "cus_ent_messages",
		customerProductId: "cus_prod_test",
		featureId: "messages",
		featureName: "Messages",
		allowance: 100,
		balance: 100,
		usageAllowed,
	});
	entitlement.entitlement.usage_limit = usageLimit;

	const plan = customerProducts.create({
		id: "cus_prod_test",
		productId: "prod_test",
		customerEntitlements: [entitlement],
	});
	const fullSubject = fullCustomerToFullSubject({
		fullCustomer: customers.create({ customerProducts: [plan] }),
	});
	const feature = plan.customer_entitlements[0].entitlement.feature;

	const ctx = contexts.create({ features: [feature] });
	ctx.org.config = OrgConfigSchema.parse({});
	ctx.apiVersion = new ApiVersionClass(LATEST_VERSION);
	ctx.expand = [];
	ctx.timestamp = Date.now();

	return { ctx, feature, fullSubject };
};

const minBalanceFor = ({
	usageAllowed,
	usageLimit = null,
}: {
	usageAllowed: boolean;
	usageLimit?: number | null;
}) => {
	const { ctx, feature, fullSubject } = setup({ usageAllowed, usageLimit });
	const prepared = prepareFeatureDeductionV2({
		ctx,
		fullSubject,
		deduction: { feature, deduction: 10 },
		options: { overageBehaviour: "cap" },
	});
	return prepared.customerEntitlementDeductions[0]?.min_balance;
};

test("no overage: the balance floors at zero", () => {
	expect(minBalanceFor({ usageAllowed: false })).toBe(0);
});

test("overage allowed without a limit: no floor (the debt is collected)", () => {
	expect(minBalanceFor({ usageAllowed: true })).toBeUndefined();
});

test("overage allowed with a usage limit: the floor is the limit", () => {
	// allowance 100, usage limit 300 -> 200 credits of overage are permitted.
	expect(minBalanceFor({ usageAllowed: true, usageLimit: 300 })).toBe(-200);
});
