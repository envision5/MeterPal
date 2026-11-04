import type {
	AutumnBillingPlan,
	BillingContext,
	PreviewBillingPlan,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { computeAttachInvoiceCreditPreview } from "./invoiceCredits/computeAttachInvoiceCreditPreview";

/**
 * Build-stage orchestrator for preview-only enrichments. Invoked from
 * action handlers ONLY when `preview: true`. Assembles the
 * `PreviewBillingPlan` bag that lives at `billingPlan.preview`.
 */
export const computeAttachPreviewBillingPlan = async ({
	ctx,
	billingContext,
}: {
	ctx: AutumnContext;
	billingContext: BillingContext;
	autumnBillingPlan?: AutumnBillingPlan;
}): Promise<PreviewBillingPlan> => {
	const invoiceCredits = computeAttachInvoiceCreditPreview({
		ctx,
		billingContext,
	});

	return { invoiceCredits };
};
