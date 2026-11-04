import type { Reward, RewardProgram } from "@autumn/shared";
import { filterRewardsByProduct, RewardType } from "@autumn/shared";

/** Unified type for discount options. */
export type DiscountOption = {
	id: string;
	label: string;
	sublabel?: string;
	source: "autumn";
	/** Extra strings the option can be searched by, e.g. its promo codes */
	searchTerms: string[];
};

/** Mirrors the picker's own filter: name, id, or any of the option's codes. */
export const discountOptionMatchesSearch = ({
	option,
	search,
}: {
	option: DiscountOption;
	search: string;
}): boolean => {
	const searchLower = search.trim().toLowerCase();
	if (!searchLower) return true;
	return [option.label, option.id, ...option.searchTerms].some((term) =>
		term.toLowerCase().includes(searchLower),
	);
};

/** Filters rewards to only show discount types (not free products) */
export const filterDiscountRewards = (rewards: Reward[]): Reward[] => {
	return rewards.filter(
		(r) =>
			r.type === RewardType.PercentageDiscount ||
			r.type === RewardType.FixedDiscount,
	);
};

/** Converts an Autumn reward to a unified discount option */
export const rewardToOption = (reward: Reward): DiscountOption => {
	const promoCodes = (reward.promo_codes ?? [])
		.map((promoCode) => promoCode.code)
		.filter(Boolean);

	return {
		id: reward.id,
		label: reward.name || reward.id,
		sublabel: promoCodes[0],
		source: "autumn",
		searchTerms: promoCodes,
	};
};

/** Builds a deduplicated list of discount options from Autumn rewards */
export const buildDiscountOptions = ({
	rewards,
	rewardPrograms,
	productId,
}: {
	rewards: Reward[];
	rewardPrograms: RewardProgram[];
	productId: string | undefined;
}): DiscountOption[] => {
	return filterRewardsByProduct({
		rewards: filterDiscountRewards(rewards),
		rewardPrograms,
		productId,
	}).map(rewardToOption);
};
