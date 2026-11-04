import {
	type ApiPlanV1,
	type FullProduct,
	type UpdateVariantParams,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { ProductService } from "@/internal/products/ProductService.js";
import { getPlanResponse } from "@/internal/products/productUtils/productResponseUtils/getPlanResponse.js";
import {
	validateDirectVariantMigrationDraftUnsupported,
	variantCustomizeChanged,
} from "../common/variantUpdateSource.js";

export type VariantMigrationSnapshot = {
	product: FullProduct;
	plan: ApiPlanV1;
};

const unique = (ids: string[]) => [...new Set(ids)];

export const getVariantMigrationSnapshots = async ({
	ctx,
	variantIds,
}: {
	ctx: AutumnContext;
	variantIds: string[];
}): Promise<VariantMigrationSnapshot[]> => {
	if (variantIds.length === 0) return [];

	const variants = await ProductService.listFull({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		inIds: unique(variantIds),
	});

	return Promise.all(
		variants.map(async (product) => ({
			product,
			plan: await getPlanResponse({
				ctx,
				product,
				features: ctx.features,
			}),
		})),
	);
};

export const validateNoDirectVariantMigrationDrafts = ({
	hasMigrationDraft,
	variantUpdates,
	variantsBefore,
}: {
	hasMigrationDraft: boolean;
	variantUpdates: UpdateVariantParams[];
	variantsBefore: VariantMigrationSnapshot[];
}) => {
	if (!hasMigrationDraft) return;

	const beforeById = new Map(
		variantsBefore.map((snapshot) => [snapshot.product.id, snapshot]),
	);
	for (const variantUpdate of variantUpdates) {
		const before = beforeById.get(variantUpdate.variant_plan_id);
		if (!before) continue;
		validateDirectVariantMigrationDraftUnsupported({
			hasMigrationDraft: true,
			isDirect: variantCustomizeChanged({
				currentCustomize: before.plan.variant_details?.customize,
				incomingCustomize: variantUpdate.customize,
			}),
			variantPlanId: variantUpdate.variant_plan_id,
		});
	}
};

