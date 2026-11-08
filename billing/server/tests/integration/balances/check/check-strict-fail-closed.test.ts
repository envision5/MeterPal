/** DEP_FAILURE_POLICY=fail_closed: a check whose dependency dies sheds with a
 *  503 instead of returning the 202-allowed fail-open fallback. The fail_open
 *  counterpart (202 allowed) is covered by check-fallback.test.ts. */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { ApiVersion } from "@autumn/shared";
import { TestFeature } from "@tests/setup/v2Features.js";
import { items } from "@tests/utils/fixtures/items.js";
import { products } from "@tests/utils/fixtures/products.js";
import { initScenario, s } from "@tests/utils/testInitUtils/initScenario.js";
import chalk from "chalk";
import { createHonoApp } from "@/initHono.js";

const GET_FULL_SUBJECT_MODULE =
	"@/internal/customers/repos/getFullSubject/index.js";

// Capture the real implementations from the inner modules, BELOW the mocked
// barrel: bun's mock.module patches already-imported namespaces in place, so
// delegating to the barrel's export would recurse into the mock itself. The
// factory must cover every barrel export (a partial factory breaks the ones
// it omits).
const realGetFullSubjectImpl = await import(
	"@/internal/customers/repos/getFullSubject/getFullSubject.js"
);
const realQueryImpl = await import(
	"@/internal/customers/repos/getFullSubject/getFullSubjectQuery.js"
);
const realRowMappingImpl = await import(
	"@/internal/customers/repos/getFullSubject/subjectQueryRowToNormalized.js"
);
const realGetFullSubjectNormalized =
	realGetFullSubjectImpl.getFullSubjectNormalized;

const outageCustomerIds = new Set<string>();

mock.module(GET_FULL_SUBJECT_MODULE, () => ({
	...realGetFullSubjectImpl,
	...realQueryImpl,
	...realRowMappingImpl,
	getFullSubjectNormalized: async (
		args: Parameters<typeof realGetFullSubjectNormalized>[0],
	) => {
		if (args.customerId && outageCustomerIds.has(args.customerId)) {
			const error = new Error("simulated db outage") as Error & {
				code: string;
			};
			error.code = "CONNECT_TIMEOUT";
			throw error;
		}
		return realGetFullSubjectNormalized(args);
	},
}));

const originalPolicy = process.env.DEP_FAILURE_POLICY;

beforeEach(() => {
	process.env.DEP_FAILURE_POLICY = "fail_closed";
});

afterAll(() => {
	outageCustomerIds.clear();
	if (originalPolicy === undefined) delete process.env.DEP_FAILURE_POLICY;
	else process.env.DEP_FAILURE_POLICY = originalPolicy;
	mock.module(GET_FULL_SUBJECT_MODULE, () => realGetFullSubjectImpl);
});

const runCheck = async (customerId: string) => {
	const app = createHonoApp();
	return await app.fetch(
		new Request("http://localhost/v1/balances.check", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.UNIT_TEST_AUTUMN_SECRET_KEY || ""}`,
				"Content-Type": "application/json",
				"x-api-version": ApiVersion.V2_1.toString(),
				"x-skip-cache": "true",
			},
			body: JSON.stringify({
				customer_id: customerId,
				feature_id: TestFeature.Messages,
			}),
		}),
	);
};

test(
	`${chalk.yellowBright("check-strict: dependency outage sheds with 503 under fail_closed")}`,
	async () => {
		const messagesItem = items.monthlyMessages({ includedUsage: 1000 });
		const freeProd = products.base({
			id: "check-strict-free",
			items: [messagesItem],
		});

		const { customerId } = await initScenario({
			customerId: "check-strict-fail-closed",
			setup: [s.customer({ testClock: false }), s.products({ list: [freeProd] })],
			actions: [s.billing.attach({ productId: freeProd.id })],
		});

		try {
			outageCustomerIds.add(customerId);
			const response = await runCheck(customerId);

			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("1");
			const body = (await response.json()) as { code?: string };
			expect(body.code).toBe("service_unavailable");
		} finally {
			outageCustomerIds.delete(customerId);
		}
	},
);

test(
	`${chalk.yellowBright("check-strict: healthy request still succeeds under fail_closed")}`,
	async () => {
		const messagesItem = items.monthlyMessages({ includedUsage: 1000 });
		const freeProd = products.base({
			id: "check-strict-healthy-free",
			items: [messagesItem],
		});

		const { customerId } = await initScenario({
			customerId: "check-strict-healthy",
			setup: [s.customer({ testClock: false }), s.products({ list: [freeProd] })],
			actions: [s.billing.attach({ productId: freeProd.id })],
		});

		const response = await runCheck(customerId);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { allowed?: boolean };
		expect(body.allowed).toBe(true);
	},
);
