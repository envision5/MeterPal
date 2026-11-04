import type {
	BillingContext,
	BillingPlan,
	FullCusProduct,
} from "@autumn/shared";
import {
	type BillingPreviewResponse,
	billingContextResetsUsage,
	billingContextToCurrency,
} from "@autumn/shared";
import { Decimal } from "decimal.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { billingPlanToImmediatePreview } from "./billingPlan/toImmediatePreview/billingPlanToImmediatePreview";
import { billingPlanToNextCyclePreview } from "./billingPlan/toNextCyclePreview/billingPlanToNextCyclePreview";
import { billingPlanToChanges } from "./billingPlan/toPreviewChanges/billingPlanToChanges";
import { logBillingPreview } from "./logs/logBillingPreview";

/**
 * Apply preview-layer adjustments (processor tax, processor customer credit
 * balance) to the immediate-period total. Mirrors what the processor will
 * actually invoice:
 *  - Tax is added on top of the discounted subtotal.
 *  - Customer credit is subtracted, capped at (subtotal + tax) so the total
 *    never goes negative.
 *
 * If `billingPlan.preview` is undefined (non-attach flows that skip the
 * enrichment step) the math is a no-op and `total` is unchanged.
 */
const applyPreviewAdjustmentsToTotal = ({
	subtotal,
	total,
	billingPlan,
}: {
	subtotal: number;
	total: number;
	billingPlan: BillingPlan;
}): { total: number; creditApplied: number } => {
	const taxTotal = billingPlan.preview?.tax?.total ?? 0;
	const creditBalance = billingPlan.preview?.invoiceCredits?.balance ?? 0;

	const taxed = new Decimal(total).add(taxTotal);
	const cappedCredit = Decimal.min(creditBalance, Decimal.max(taxed, 0));
	return {
		total: taxed.sub(cappedCredit).toDP(2).toNumber(),
		creditApplied: cappedCredit.toDP(2).toNumber(),
	};
};

export const billingPlanToPreviewResponse = async ({
	ctx,
	billingContext,
	billingPlan,
	nextCycleCustomerProductFilter,
}: {
	ctx: AutumnContext;
	billingContext: BillingContext;
	billingPlan: BillingPlan;
	/** Scope next_cycle to a subset of products (e.g. one subscription's). */
	nextCycleCustomerProductFilter?: (customerProduct: FullCusProduct) => boolean;
}): Promise<BillingPreviewResponse & { credit_applied: number }> => {
	const { fullCustomer } = billingContext;

	const autumnBillingPlan = billingPlan.autumn;
	const allLineItems = autumnBillingPlan.lineItems ?? [];
	const currency = billingContextToCurrency({ org: ctx.org, billingContext });

	const {
		immediateLineItems,
		previewLineItems,
		subtotal,
		total: lineItemsTotal,
	} = billingPlanToImmediatePreview({
		billingContext,
		billingPlan,
		currency,
	});

	const { total, creditApplied } = applyPreviewAdjustmentsToTotal({
		subtotal,
		total: lineItemsTotal,
		billingPlan,
	});

	// Get next cycle object
	const { nextCycle: rawNextCycle, debug: nextCycleDebug } =
		billingPlanToNextCyclePreview({
			ctx,
			billingContext,
			billingPlan,
			customerProductFilter: nextCycleCustomerProductFilter,
		});

	const nextCycle = rawNextCycle;

	logBillingPreview({
		ctx,
		allLineItems,
		immediateLineItems,
		total,
		currency,
		nextCycleDebug,
		nextCycle,
	});

	const { incoming, outgoing } = await billingPlanToChanges({
		ctx,
		billingContext,
		billingPlan,
	});

	return {
		object: "billing_preview" as const,
		customer_id: fullCustomer.id || "",
		line_items: previewLineItems,
		subtotal,
		total,
		// total is already net of credit here, so amount_due would only repeat it.
		credit_applied: creditApplied,
		currency,
		resets_usage: billingContextResetsUsage(billingContext),
		next_cycle: nextCycle,
		incoming,
		outgoing,
		refund: autumnBillingPlan.refundPlan
			? {
					amount: autumnBillingPlan.refundPlan.amount,
					invoice: {
						processor_invoice_id:
							autumnBillingPlan.refundPlan.invoice.processor_invoice_id,
						total: autumnBillingPlan.refundPlan.invoice.total,
						current_refunded_amount:
							autumnBillingPlan.refundPlan.invoice.current_refunded_amount,
						currency: autumnBillingPlan.refundPlan.invoice.currency,
					},
				}
			: undefined,
	};
};
