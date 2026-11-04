import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AppEnv, ErrCode } from "@autumn/shared";

/** Every delete the reset performs, in the order it performed them. */
const calls: string[] = [];

await mockModuleWithRestore(
	"@/external/redis/actions/productsCache/productsCache.js",
	() => ({
		invalidateProductsCache: async () => {
			calls.push("cache:products");
		},
	}),
);
await mockModuleWithRestore(
	"@/internal/orgs/orgUtils/clearOrgCache.js",
	() => ({
		clearOrgCache: async () => {
			calls.push("cache:org");
		},
	}),
);

import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { CusService } from "@/internal/customers/CusService.js";
import { FeatureService } from "@/internal/features/FeatureService.js";
import { ProductService } from "@/internal/products/ProductService.js";
import { resetSandbox } from "@/internal/sandboxes/resetSandbox.js";
import { mockModuleWithRestore } from "../utils/mockModuleWithRestore.js";

/** The reset runs its deletes in one transaction; the stub just runs the body. */
const contextFor = ({ env }: { env: AppEnv }): AutumnContext =>
	({
		db: {
			transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
				calls.push("tx:begin");
				const result = await run({});
				calls.push("tx:commit");
				return result;
			},
		},
		org: { id: "org_sandbox" },
		env,
		logger: { info: () => {}, warn: () => {}, error: () => {} },
	}) as unknown as AutumnContext;

const spies: { mockRestore: () => void }[] = [];

const stubDeletes = () => {
	spies.push(
		spyOn(CusService, "safeDeleteByOrgId").mockImplementation(async () => {
			calls.push("customers");
		}),
		spyOn(ProductService, "safeDeleteByOrgId").mockImplementation(async () => {
			calls.push("products");
		}),
		spyOn(FeatureService, "safeDeleteByOrgId").mockImplementation(async () => {
			calls.push("features");
		}),
	);
};

beforeEach(() => {
	calls.length = 0;
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("resetSandbox (sandbox-only)", () => {
	test("refuses a live environment with a 400, and deletes nothing", async () => {
		stubDeletes();

		await expect(
			resetSandbox({ ctx: contextFor({ env: AppEnv.Live }) }),
		).rejects.toMatchObject({
			code: ErrCode.InvalidRequest,
			statusCode: 400,
			message: "Only sandboxes can be reset",
		});
		expect(calls).toEqual([]);
	});

	test("deletes customers, products and features", async () => {
		stubDeletes();

		await resetSandbox({ ctx: contextFor({ env: AppEnv.Sandbox }) });

		expect(calls).toEqual([
			"tx:begin",
			"customers",
			"products",
			"features",
			"tx:commit",
			"cache:products",
			"cache:org",
		]);
	});

	test("a failed delete still drops the caches the wipe would have staled", async () => {
		stubDeletes();
		spies.push(
			spyOn(ProductService, "safeDeleteByOrgId").mockImplementation(
				async () => {
					throw new Error("products delete failed");
				},
			),
		);

		await expect(
			resetSandbox({ ctx: contextFor({ env: AppEnv.Sandbox }) }),
		).rejects.toThrow("products delete failed");

		expect(calls).toEqual([
			"tx:begin",
			"customers",
			"cache:products",
			"cache:org",
		]);
	});
});
