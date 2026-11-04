import type { FullProduct, ProductKey } from "@autumn/shared";
import type { CustomerProductVersioningFlags } from "@/internal/customers/cusProducts/repos/getVersioningUsage.js";

/** One setup/projected row for a single productKey. */
export type ProductState = {
	productKey: ProductKey;
	currentFullProduct: FullProduct;
	customerUsage: CustomerProductVersioningFlags;
};

/**
 * Product setup bag: per-key state plus plan-scoped indexes expand/errors need
 * (sibling versions).
 */
export type ProductStatesContext = {
	/** Existing states keyed by `productKeyToString`. */
	statesByPlanVersion: Record<string, ProductState>;
	/** Existing versions per plan_id, newest first (empty = plan absent). */
	versionsByPlanId: Record<string, FullProduct[]>;
	/** `MAX(version)` including tombstones — mint occupancy. */
	maxVersionByPlanId?: Record<string, number>;
};

export const emptyProductStatesContext = (): ProductStatesContext => ({
	statesByPlanVersion: {},
	versionsByPlanId: {},
	maxVersionByPlanId: {},
});
