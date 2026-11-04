import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { handleUpdateSubscriptionErrors } from "@/internal/billing/v2/actions/updateSubscription/errors/handleUpdateSubscriptionErrors";
import { handleUnsupportedLicenseActionErrors } from "@/internal/billing/v2/common/errors/handleUnsupportedLicenseActionErrors";
import type { MultiUpdateItemResult } from "../compute/computeMultiUpdateFold";

/**
 * Per-item gates run against the item's OWN plan. The subscription-level plan
 * carries sibling items' artifacts (e.g. an immediate cancel's credit invoice
 * would false-positive the end-of-cycle charge guard), so each item is
 * validated in isolation.
 */
export const handleMultiUpdateErrors = async ({
	ctx,
	itemResults,
}: {
	ctx: AutumnContext;
	itemResults: MultiUpdateItemResult[];
}) => {
	for (const itemResult of itemResults) {
		handleUnsupportedLicenseActionErrors({
			actionLabel: "billing.multi_update",
			fullProducts: itemResult.billingContext.fullProducts,
			customerProducts: [itemResult.billingContext.customerProduct],
		});

		await handleUpdateSubscriptionErrors({
			ctx,
			billingContext: itemResult.billingContext,
			billingPlan: {
				autumn: itemResult.itemPlan,
			},
			params: itemResult.params,
		});
	}
};
