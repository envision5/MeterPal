import type { FullProduct } from "@autumn/shared";
import { productKeyToString, productToProductKey } from "@autumn/shared";
import type {
	ProductState,
	ProductStatesContext,
} from "@/internal/catalogV2/actions/updateCatalog/types/updateCatalogContext";
import {
	type CustomerProductVersioningFlags,
	emptyVersioningFlags,
} from "@/internal/customers/cusProducts/repos/getVersioningUsage.js";

/** One ProductState per existing productKey, plus plan-scoped indexes. */
export const buildProductStatesContext = ({
	planIds,
	versionsByPlanId,
	usageByInternalId,
	maxVersionByPlanId,
}: {
	planIds: string[];
	versionsByPlanId: Map<string, FullProduct[]>;
	usageByInternalId: Map<string, CustomerProductVersioningFlags>;
	maxVersionByPlanId?: Record<string, number>;
}): ProductStatesContext => {
	const statesByPlanVersion: Record<string, ProductState> = {};
	const versionsByPlanIdRecord: ProductStatesContext["versionsByPlanId"] = {};
	const maxVersionByPlanIdRecord: ProductStatesContext["maxVersionByPlanId"] =
		{};

	for (const planId of planIds) {
		const versions = versionsByPlanId.get(planId) ?? [];
		const liveVersions = versions.filter(
			(product) => product.deleted_at == null,
		);
		versionsByPlanIdRecord[planId] = liveVersions;
		maxVersionByPlanIdRecord[planId] = Math.max(
			maxVersionByPlanId?.[planId] ?? 0,
			...versions.map((product) => product.version),
		);

		for (const currentFullProduct of liveVersions) {
			const productKey = productToProductKey({ product: currentFullProduct });
			statesByPlanVersion[productKeyToString({ productKey })] = {
				productKey,
				currentFullProduct,
				customerUsage:
					usageByInternalId.get(currentFullProduct.internal_id) ??
					emptyVersioningFlags(),
			};
		}
	}

	return {
		statesByPlanVersion,
		versionsByPlanId: versionsByPlanIdRecord,
		maxVersionByPlanId: maxVersionByPlanIdRecord,
	};
};
