import { formatMs, type MultiAttachBillingContext } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { addToExtraLogs } from "@/utils/logging/addToExtraLogs";

/**
 * Logs the multi-attach billing context for observability.
 */
export const logMultiAttachContext = ({
	ctx,
	billingContext,
}: {
	ctx: AutumnContext;
	billingContext: MultiAttachBillingContext;
}) => {
	const {
		productContexts,
		fullCustomer,
		checkoutMode,
		featureQuantities,
		currentEpochMs,
		invoiceMode,
		isCustom,
		billingCycleAnchorMs,
		resetCycleAnchorMs,
		trialContext,
	} = billingContext;

	const plansSummary = productContexts
		.map((pc) => {
			const fp = pc.fullProduct;
			return `${fp.id} (v${fp.version})`;
		})
		.join(", ");

	addToExtraLogs({
		ctx,
		extras: {
			multiAttachContext: {
				customer: fullCustomer.id,
				plans: plansSummary,
				isCustom: isCustom ?? false,

				checkoutMode: checkoutMode ?? "direct billing",

				timestamps: `Current: ${formatMs(currentEpochMs)} | Billing Anchor: ${billingCycleAnchorMs === "now" ? "now" : formatMs(billingCycleAnchorMs)} | Reset: ${formatMs(resetCycleAnchorMs)}`,

				invoiceMode: invoiceMode
					? `enable immediately: ${invoiceMode.enableProductImmediately} | finalize invoice: ${invoiceMode.finalizeInvoice}`
					: "default",

				processor: productContexts
					.map(
						(productContext) =>
							productContext.currentCustomerProduct?.subscription_ids?.join(
								", ",
							) ?? "none",
					)
					.join(" | "),

				featureQuantities:
					featureQuantities.length > 0
						? featureQuantities
								.map((fq) => `${fq.feature_id}: ${fq.quantity}`)
								.join(", ")
						: "none",

				trialContext: trialContext
					? `trial ends at: ${formatMs(trialContext.trialEndsAt)} | free trial ID: ${trialContext.freeTrial?.id ?? "none"} | appliesToBilling: ${trialContext.appliesToBilling}`
					: "none",
			},
		},
	});
};
