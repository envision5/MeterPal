import { describe, expect, test } from "bun:test";
import type { Feature, ProductV2 } from "@autumn/shared";
import {
	buildProductPriceGroups,
	expandToFullGroups,
	groupLabel,
	groupSuffix,
	isGroupSelected,
	sharedProductHint,
} from "@/views/products/rewards/reward-config/components/productPriceGroups";

const plan = ({
	id,
	baseId,
	priceIds = [`${id}_price`],
}: {
	id: string;
	baseId?: string | null;
	priceIds?: string[];
}) =>
	({
		id,
		name: id,
		base_id: baseId ?? null,
		items: priceIds.map((priceId) => ({
			price_id: priceId,
			price: 10,
		})),
	}) as unknown as ProductV2;

describe("buildProductPriceGroups", () => {
	test("plans sharing a base plan land in one group", () => {
		const groups = buildProductPriceGroups({
			products: [plan({ id: "pro" }), plan({ id: "pro-yearly", baseId: "pro" })],
		});

		expect(groups).toHaveLength(1);
		expect(groups[0].priceIds).toEqual(["pro_price", "pro-yearly_price"]);
	});

	test("plans with distinct base ids stay separate", () => {
		const groups = buildProductPriceGroups({
			products: [plan({ id: "pro" }), plan({ id: "team" })],
		});

		expect(groups).toHaveLength(2);
	});

	test("plans with no priced items are excluded", () => {
		const groups = buildProductPriceGroups({
			products: [plan({ id: "free", priceIds: [] })],
		});

		expect(groups).toHaveLength(0);
	});
});

describe("groupLabel", () => {
	test("a lone plan shows its own name", () => {
		const [group] = buildProductPriceGroups({
			products: [plan({ id: "Pro" })],
		});
		expect(groupLabel({ group })).toBe("Pro");
		expect(groupSuffix({ group })).toBeNull();
	});

	test("a plan family collapses to a variant count", () => {
		const [group] = buildProductPriceGroups({
			products: [
				plan({ id: "Pro" }),
				plan({ id: "Pro Yearly", baseId: "Pro" }),
				plan({ id: "Pro Quarterly", baseId: "Pro" }),
			],
		});
		expect(groupSuffix({ group })).toBe("+ 2 variants");
	});

	test("a single sibling is not pluralised", () => {
		const [group] = buildProductPriceGroups({
			products: [
				plan({ id: "Pro" }),
				plan({ id: "Pro Yearly", baseId: "Pro" }),
			],
		});
		expect(groupSuffix({ group })).toBe("+ 1 variant");
	});
});

describe("isGroupSelected", () => {
	const [group] = buildProductPriceGroups({
		products: [
			plan({ id: "pro" }),
			plan({ id: "pro-yearly", baseId: "pro" }),
		],
	});

	test("every price selected counts as selected", () => {
		expect(
			isGroupSelected({
				group,
				priceIds: ["pro_price", "pro-yearly_price"],
			}),
		).toBe(true);
	});

	test("a partial selection does not count", () => {
		expect(isGroupSelected({ group, priceIds: ["pro_price"] })).toBe(false);
	});
});

describe("expandToFullGroups", () => {
	test("a legacy partial selection expands to the whole group", () => {
		const groups = buildProductPriceGroups({
			products: [
				plan({ id: "pro" }),
				plan({ id: "pro-yearly", baseId: "pro" }),
			],
		});

		expect(
			expandToFullGroups({ groups, priceIds: ["pro_price"] }).sort(),
		).toEqual(["pro-yearly_price", "pro_price"]);
	});

	test("an already-complete selection is unchanged", () => {
		const groups = buildProductPriceGroups({
			products: [plan({ id: "pro" })],
		});

		expect(expandToFullGroups({ groups, priceIds: ["pro_price"] })).toEqual([
			"pro_price",
		]);
	});

	test("a price from an unknown historical version is kept as-is", () => {
		const groups = buildProductPriceGroups({
			products: [plan({ id: "pro" })],
		});

		expect(expandToFullGroups({ groups, priceIds: ["orphan_price"] })).toEqual([
			"orphan_price",
		]);
	});
});

describe("duplicate product entries", () => {
	test("the same plan appearing twice does not double its price ids", () => {
		const pro = plan({ id: "pro" });
		const groups = buildProductPriceGroups({ products: [pro, pro] });

		expect(groups).toHaveLength(1);
		expect(groups[0].priceIds).toEqual(["pro_price"]);
		expect(groupSuffix({ group: groups[0] })).toBeNull();
	});
});

const usagePlan = ({
	id,
	featureId,
	priceId = `${id}_usage_price`,
}: {
	id: string;
	featureId: string;
	priceId?: string;
}) =>
	({
		id,
		name: id,
		base_id: null,
		items: [{ price_id: priceId, price: 5, feature_id: featureId }],
	}) as unknown as ProductV2;

const proWithUsage = {
	id: "pro",
	name: "pro",
	base_id: null,
	items: [
		{ price_id: "pro_base", price: 20 },
		{ price_id: "pro_usage", price: 5, feature_id: "messages" },
	],
} as unknown as ProductV2;

describe("usage prices get their own feature-level group", () => {
	test("unrelated plans charging the same feature share one feature group", () => {
		const groups = buildProductPriceGroups({
			products: [
				usagePlan({ id: "pro", featureId: "messages" }),
				usagePlan({ id: "team", featureId: "messages" }),
			],
		});

		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe("feature");
		expect(groups[0].priceIds.sort()).toEqual([
			"pro_usage_price",
			"team_usage_price",
		]);
	});

	test("plans charging different features stay separate", () => {
		const groups = buildProductPriceGroups({
			products: [
				usagePlan({ id: "pro", featureId: "messages" }),
				usagePlan({ id: "team", featureId: "words" }),
			],
		});

		expect(groups).toHaveLength(2);
	});

	test("a shared feature does not merge plans' base prices", () => {
		const groups = buildProductPriceGroups({
			products: [
				proWithUsage,
				usagePlan({ id: "team", featureId: "messages" }),
			],
		});

		expect(groups.map(({ kind, priceIds }) => ({ kind, priceIds }))).toEqual([
			{ kind: "plan", priceIds: ["pro_base"] },
			{ kind: "feature", priceIds: ["pro_usage", "team_usage_price"] },
		]);
	});

	test("a feature group is labelled with the feature name", () => {
		const groups = buildProductPriceGroups({
			products: [proWithUsage],
			features: [{ id: "messages", name: "Messages" } as Feature],
		});

		expect(groupLabel({ group: groups[1] })).toBe("Messages");
	});

	test("a feature group falls back to the feature id", () => {
		const groups = buildProductPriceGroups({ products: [proWithUsage] });

		expect(groupLabel({ group: groups[1] })).toBe("messages");
	});
});

describe("sharedProductHint", () => {
	test("lists the plans a discount reaches, one per line", () => {
		const [group] = buildProductPriceGroups({
			products: [
				plan({ id: "Pro" }),
				plan({ id: "Pro Yearly", baseId: "Pro" }),
			],
		});

		expect(sharedProductHint({ group })).toBe(
			"A discount here applies to:\n  • Pro\n  • Pro Yearly",
		);
	});
});

describe("groupSuffix wording", () => {
	test("a variant family counts variants", () => {
		const [group] = buildProductPriceGroups({
			products: [
				plan({ id: "pro" }),
				plan({ id: "pro-yearly", baseId: "pro" }),
			],
		});
		expect(groupSuffix({ group })).toBe("+ 1 variant");
	});

	test("a feature group counts the plans billing it", () => {
		const [group] = buildProductPriceGroups({
			products: [
				usagePlan({ id: "pro", featureId: "messages" }),
				usagePlan({ id: "team", featureId: "messages" }),
			],
		});
		expect(groupSuffix({ group })).toBe("usage · 2 plans");
		expect(sharedProductHint({ group })).toBe(
			"Discounts messages usage on:\n  • pro\n  • team",
		);
	});
});

describe("a plan with variants and a shared feature", () => {
	test("the variant family and the feature usage are separate options", () => {
		const groups = buildProductPriceGroups({
			products: [
				proWithUsage,
				plan({ id: "pro-yearly", baseId: "pro" }),
				usagePlan({ id: "team", featureId: "messages" }),
			],
		});

		expect(groups).toHaveLength(2);
		const [planGroup, featureGroup] = groups;
		expect(planGroup.priceIds).toEqual(["pro_base", "pro-yearly_price"]);
		expect(groupSuffix({ group: planGroup })).toBe("+ 1 variant");
		expect(featureGroup.products.map(({ id }) => id)).toEqual(["pro", "team"]);
	});
});

describe("the base plan leads its group", () => {
	test("a variant listed before its base still reads Base + N variants", () => {
		const groups = buildProductPriceGroups({
			products: [
				plan({ id: "Legacy Variant", baseId: "Legacy Base" }),
				plan({ id: "Legacy Base" }),
			],
		});

		expect(groupLabel({ group: groups[0] })).toBe("Legacy Base");
		expect(groupSuffix({ group: groups[0] })).toBe("+ 1 variant");
	});

	test("two variants listed before the base count variants", () => {
		const groups = buildProductPriceGroups({
			products: [
				plan({ id: "Pro Yearly", baseId: "Pro" }),
				plan({ id: "Pro Quarterly", baseId: "Pro" }),
				plan({ id: "Pro" }),
			],
		});

		expect(groupLabel({ group: groups[0] })).toBe("Pro");
		expect(groupSuffix({ group: groups[0] })).toBe("+ 2 variants");
	});
});

describe("sharedProductHint ordering", () => {
	test("the base is listed first even when a variant comes first", () => {
		const [group] = buildProductPriceGroups({
			products: [
				plan({ id: "Pro Yearly", baseId: "Pro" }),
				plan({ id: "Pro" }),
			],
		});

		expect(sharedProductHint({ group })).toBe(
			"A discount here applies to:\n  • Pro\n  • Pro Yearly",
		);
	});
});
