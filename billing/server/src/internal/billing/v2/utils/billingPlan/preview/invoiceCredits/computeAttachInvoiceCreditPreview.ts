import type { BillingContext, PreviewInvoiceCredits } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";

/**
 * Build-stage helper that surfaces the customer's credit balance on the attach
 * preview so sales/dashboard users can see how much credit will offset the
 * next invoice.
 *
 * Processor-hosted customer balances have no PayPal equivalent and no
 * Autumn-side ledger, so there is no credit to surface.
 */
export const computeAttachInvoiceCreditPreview = ({
	ctx,
	billingContext,
}: {
	ctx: AutumnContext;
	billingContext: BillingContext;
}): PreviewInvoiceCredits | undefined => {
	return undefined;
};
