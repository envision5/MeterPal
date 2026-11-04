import {
	type ApiPlanV1,
	ApiVersionClass,
	dbToApiFeatureV1,
	evaluateCatalogItemIdentity,
	type FullProduct,
	type GetCatalogParams,
	type GetCatalogResponse,
	LATEST_VERSION,
} from "@autumn/shared";
import { catalogVariantIdentity } from "@autumn/shared/api/catalogV2/planUpdate/params/catalogVariantParams.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { ProductService } from "@/internal/products/ProductService.js";
import { getPlanResponse } from "@/internal/products/productUtils/productResponseUtils/getPlanResponse.js";

const FEATURE_TARGET_VERSION = new ApiVersionClass(LATEST_VERSION);

const withItemMappingIdentities = <T extends Pick<ApiPlanV1, "items">>({
	plan,
}: {
	plan: T;
}) => ({
	...plan,
	items: plan.items.map((item) => ({
		...item,
		mapping_identity: JSON.stringify(evaluateCatalogItemIdentity({ item })),
	})),
});

/** Read the entire catalog — features plus latest top-level plans with variant/license edges. */
export const getCatalogV2 = async ({
	ctx,
	params,
}: {
	ctx: AutumnContext;
	params: GetCatalogParams;
}): Promise<GetCatalogResponse> => {
	const { include_archived = false, include_versions = false } = params ?? {};

	const products = await ProductService.listFull({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		archived: include_archived ? undefined : false,
		returnAll: include_versions,
	});

	// Variants surface only nested under their base plan, never top-level.
	const baseProducts = products.filter(
		(product) => !product.base_internal_product_id,
	);
	const pruneArchivedVariants = (product: FullProduct): FullProduct => ({
		...product,
		variants: (product.variants ?? []).filter(
			(variant) => include_archived || !variant.archived,
		),
	});

	const plans = await Promise.all(
		baseProducts.map((product) =>
			getPlanResponse({
				ctx,
				product: pruneArchivedVariants(product),
				features: ctx.features,
				currency: ctx.org.default_currency || undefined,
				expandLicensePlans: true,
				expandVariants: true,
				resolveBaseFullProduct: false,
			}),
		),
	);

	const features = ctx.features
		.filter((feature) => include_archived || !feature.archived)
		.map((feature) =>
			dbToApiFeatureV1({
				ctx,
				dbFeature: feature,
				targetVersion: FEATURE_TARGET_VERSION,
			}),
		);

	return {
		features,
		plans: plans.map((plan) => ({
			...withItemMappingIdentities({ plan }),
			licenses: plan.licenses?.map((license) => ({
				...license,
				plan: license.plan
					? withItemMappingIdentities({ plan: license.plan })
					: undefined,
			})),
			variants: plan.variants?.map((variant) => ({
				...variant,
				mapping_identity: JSON.stringify(
					evaluateCatalogItemIdentity({
						item: variant,
						recipe: catalogVariantIdentity,
					}),
				),
				plan: variant.plan
					? withItemMappingIdentities({ plan: variant.plan })
					: undefined,
			})),
		})),
		// Rewards and referral programs are not part of the catalog surface
		// anymore — the catalog states plans and features only.
		rewards: [],
		referral_programs: [],
	};
};
