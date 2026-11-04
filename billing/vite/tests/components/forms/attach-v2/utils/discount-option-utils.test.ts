import { describe, expect, test } from "bun:test";
import {
	CouponDurationType,
	type Reward,
	type RewardProgram,
	RewardType,
} from "@autumn/shared";
import {
	buildDiscountOptions,
	filterDiscountRewards,
	rewardToOption,
} from "@/components/forms/attach-v2/utils/discountOptionUtils";

function makeReward(overrides: Partial<Reward> & { id: string }): Reward {
	return {
		name: null,
		promo_codes: [],
		type: RewardType.PercentageDiscount,
		free_product_id: null,
		discount_config: null,
		free_product_config: null,
		internal_id: `rew_${overrides.id}`,
		org_id: "org_test",
		env: "sandbox",
		created_at: Date.now(),
		...overrides,
	};
}

function makeRewardProgram(
	overrides: Partial<RewardProgram> & {
		internal_reward_id: string;
		product_ids: string[];
	},
): RewardProgram {
	return {
		internal_id: `rp_${overrides.internal_reward_id}`,
		org_id: "org_test",
		env: "sandbox",
		created_at: Date.now(),
		...overrides,
	} as RewardProgram;
}

describe("filterDiscountRewards", () => {
	test("should keep percentage and fixed discount rewards", () => {
		const rewards = [
			makeReward({ id: "pct", type: RewardType.PercentageDiscount }),
			makeReward({ id: "fix", type: RewardType.FixedDiscount }),
		];
		const result = filterDiscountRewards(rewards);
		expect(result).toHaveLength(2);
	});

	test("should filter out free product and invoice credits rewards", () => {
		const rewards = [
			makeReward({ id: "pct", type: RewardType.PercentageDiscount }),
			makeReward({ id: "free", type: RewardType.FreeProduct }),
			makeReward({ id: "credits", type: RewardType.InvoiceCredits }),
		];
		const result = filterDiscountRewards(rewards);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("pct");
	});

	test("should return empty array when no discount rewards exist", () => {
		const rewards = [makeReward({ id: "free", type: RewardType.FreeProduct })];
		expect(filterDiscountRewards(rewards)).toHaveLength(0);
	});
});

describe("rewardToOption", () => {
	test("should use reward name as label", () => {
		const reward = makeReward({ id: "r1", name: "20% Off" });
		const option = rewardToOption(reward);
		expect(option).toEqual({
			id: "r1",
			label: "20% Off",
			sublabel: undefined,
			source: "autumn",
			searchTerms: [],
		});
	});

	test("should fall back to id when name is null", () => {
		const reward = makeReward({ id: "r1", name: null });
		expect(rewardToOption(reward).label).toBe("r1");
	});

	test("should include first promo code as sublabel", () => {
		const reward = makeReward({
			id: "r1",
			name: "Discount",
			promo_codes: [{ code: "SAVE20" }, { code: "SAVE30" }],
		});
		const option = rewardToOption(reward);
		expect(option.sublabel).toBe("SAVE20");
		// every code is searchable, not just the one on show
		expect(option.searchTerms).toEqual(["SAVE20", "SAVE30"]);
	});
});

describe("buildDiscountOptions", () => {
	test("should return autumn rewards mapped to options", () => {
		const rewards = [
			makeReward({
				id: "r1",
				name: "10% Off",
				type: RewardType.PercentageDiscount,
				discount_config: {
					discount_value: 10,
					duration_type: CouponDurationType.OneOff,
					duration_value: 0,
					apply_to_all: true,
				},
			}),
		];
		const result = buildDiscountOptions({
			rewards,
			rewardPrograms: [],
			productId: undefined,
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			id: "r1",
			label: "10% Off",
			sublabel: undefined,
			source: "autumn",
			searchTerms: [],
		});
	});

	test("should filter non-discount reward types from autumn options", () => {
		const rewards = [
			makeReward({
				id: "discount",
				type: RewardType.PercentageDiscount,
				discount_config: {
					discount_value: 10,
					duration_type: CouponDurationType.OneOff,
					duration_value: 0,
					apply_to_all: true,
				},
			}),
			makeReward({ id: "free", type: RewardType.FreeProduct }),
			makeReward({ id: "credits", type: RewardType.InvoiceCredits }),
		];
		const result = buildDiscountOptions({
			rewards,
			rewardPrograms: [],
			productId: undefined,
		});
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("discount");
	});

	test("should filter autumn rewards by product when productId is provided", () => {
		const rewards = [
			makeReward({
				id: "all_products",
				name: "All Products",
				type: RewardType.PercentageDiscount,
				discount_config: {
					discount_value: 10,
					duration_type: CouponDurationType.OneOff,
					duration_value: 0,
					apply_to_all: true,
				},
			}),
			makeReward({
				id: "specific",
				name: "Specific",
				type: RewardType.FixedDiscount,
				discount_config: {
					discount_value: 500,
					duration_type: CouponDurationType.OneOff,
					duration_value: 0,
					apply_to_all: false,
				},
			}),
		];
		const rewardPrograms = [
			makeRewardProgram({
				internal_reward_id: "rew_specific",
				product_ids: ["prod_other"],
			}),
		];
		const result = buildDiscountOptions({
			rewards,
			rewardPrograms,
			productId: "prod_target",
		});
		// Only the apply_to_all reward should pass; the specific one is linked to prod_other
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("all_products");
	});

	test("should return empty array when there are no rewards", () => {
		const result = buildDiscountOptions({
			rewards: [],
			rewardPrograms: [],
			productId: undefined,
		});
		expect(result).toHaveLength(0);
	});
});
