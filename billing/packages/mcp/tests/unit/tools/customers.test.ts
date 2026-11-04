import { expect, test } from "bun:test";
import { CustomerExpand } from "@autumn/shared";
import { customers } from "../../../src/tools/customers.js";

test("updateCustomer accepts a customer id and email", () => {
	const parsed = customers.schemas.updateCustomer.parse({
		customer_id: "customer_123",
		email: "new@example.com",
	});

	expect(parsed.customer_id).toBe("customer_123");
	expect(parsed.email).toBe("new@example.com");
});

test("getCustomer accepts the trials_used expand", () => {
	const parsed = customers.schemas.getCustomer.parse({
		customer_id: "customer_123",
		expand: [CustomerExpand.TrialsUsed],
	});

	expect(parsed.expand).toEqual([CustomerExpand.TrialsUsed]);
});
