import { beforeAll, describe, expect, test } from "bun:test";
import { ApiVersion, type CheckResponseV2 } from "@autumn/shared";
import { TestFeature } from "@tests/setup/v2Features.js";
import ctx from "@tests/utils/testInitUtils/createTestContext.js";
import chalk from "chalk";
import Decimal from "decimal.js";
import { AutumnInt } from "@/external/autumn/autumnCli.js";
import { constructFeatureItem } from "@/utils/scriptUtils/constructItem.js";
import { constructProduct } from "@/utils/scriptUtils/createTestProducts.js";
import { initTestCustomer } from "@tests/utils/testInitUtils/initTestCustomer.js";
import { initTestProducts } from "@tests/utils/testInitUtils/initTestProducts.js";

// UNCOMMENT FROM HERE
const pro = constructProduct({
	type: "free",
	isDefault: false,

	items: [
		constructFeatureItem({
			featureId: TestFeature.Messages,
			includedUsage: 200,
		}),
	],
});

describe(`${chalk.yellowBright("send-event2: Testing check with track, returned balance")}`, () => {
	const customerId = "send-event2";
	const autumnV1: AutumnInt = new AutumnInt({ version: ApiVersion.V1_2 });
	const autumnV2: AutumnInt = new AutumnInt({ version: ApiVersion.V2_0 });

	beforeAll(async () => {
		await initTestCustomer({
			ctx,
			customerId,
			customerData: {},
		});

		await initTestProducts({
			ctx,
			products: [pro],
			prefix: customerId,
		});

		await autumnV2.attach({
			customer_id: customerId,
			product_id: pro.id,
		});
	});

	test("should have correct returned balance for check with track", async () => {
		let startingBalance = 200;
		for (let i = 0; i < 20; i++) {
			const randomValue = new Decimal(Math.random()).mul(10).add(1).toNumber();
			const res = (await autumnV2.check({
				customer_id: customerId,
				feature_id: TestFeature.Messages,
				required_balance: randomValue,
				send_event: true,
			})) as unknown as CheckResponseV2;

			startingBalance = new Decimal(startingBalance)
				.minus(randomValue)
				.toNumber();

			const newBalance = res.balance?.current_balance;
			expect(new Decimal(newBalance ?? 0).toDP(7).toNumber()).toBe(
				new Decimal(startingBalance).toDP(7).toNumber(),
			);
		}
	});
});
