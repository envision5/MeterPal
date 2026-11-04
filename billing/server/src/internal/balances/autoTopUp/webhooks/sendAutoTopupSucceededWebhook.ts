import {
	ACTIVE_STATUSES,
	type BillingAutoTopupSucceededInvoice,
	fullCustomerToCustomerEntitlements,
	fullCustomerToTags,
	getApiBalance,
	WebhookEventType,
} from "@autumn/shared";
import { sendSvixEvent } from "@/external/svix/svixHelpers.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { CusService } from "@/internal/customers/CusService.js";
import { generateId } from "@/utils/genUtils.js";
import type { AutoTopupAttemptContext } from "../autoTopupContext.js";

export type AutoTopupInvoicePayload = {
	/** Processor invoice id recorded for this charge (PayPal: pp-cap-...). */
	processor_invoice_id: string;
	total: number;
	currency: string;
	hosted_invoice_url?: string | null;
};

// Refetches because the executor applies the grant via its own writes;
// the in-memory autoTopupContext.customerEntitlement may be stale.
const getBalanceAfter = async ({
	ctx,
	autoTopupContext,
}: {
	ctx: AutumnContext;
	autoTopupContext: AutoTopupAttemptContext;
}): Promise<number> => {
	const feature = autoTopupContext.customerEntitlement.entitlement.feature;
	const customerId =
		autoTopupContext.fullCustomer.id ??
		autoTopupContext.fullCustomer.internal_id;
	const fullCustomer = await CusService.getFull({
		ctx,
		idOrInternalId: customerId,
		inStatuses: ACTIVE_STATUSES,
		withSubs: true,
	});
	const customerEntitlements = fullCustomerToCustomerEntitlements({
		fullCustomer,
		featureId: feature.id,
	});
	const { data: balance } = getApiBalance({
		ctx,
		fullCus: fullCustomer,
		cusEnts: customerEntitlements,
		feature,
	});

	return balance.remaining;
};

export const sendAutoTopupSucceededWebhook = async ({
	ctx,
	autoTopupContext,
	invoice,
}: {
	ctx: AutumnContext;
	autoTopupContext: AutoTopupAttemptContext;
	invoice?: AutoTopupInvoicePayload;
}) => {
	try {
		if (!invoice) {
			ctx.logger.warn(
				"[sendAutoTopupSucceededWebhook] Missing invoice, skipping webhook",
			);
			return;
		}

		const customerId =
			autoTopupContext.fullCustomer.id ??
			autoTopupContext.fullCustomer.internal_id;
		const balanceAfter = await getBalanceAfter({ ctx, autoTopupContext });

		const invoicePayload: BillingAutoTopupSucceededInvoice = {
			processor_invoice_id: invoice.processor_invoice_id,
			status: "paid",
			total: invoice.total,
			currency: invoice.currency,
			hosted_invoice_url: invoice.hosted_invoice_url ?? null,
		};

		await sendSvixEvent({
			ctx,
			eventType: WebhookEventType.BillingAutoTopupSucceeded,
			payloadFields: {
				id: generateId("evt_auto_topup"),
				occurred_at: Date.now(),
			},
			data: {
				customer_id: customerId,
				feature_id: autoTopupContext.autoTopupConfig.feature_id,
				quantity_granted: autoTopupContext.autoTopupConfig.quantity,
				threshold: autoTopupContext.autoTopupConfig.threshold,
				balance_after: balanceAfter,
				invoice_mode: Boolean(autoTopupContext.invoiceMode),
				invoice: invoicePayload,
			},
			tags: fullCustomerToTags({
				fullCustomer: autoTopupContext.fullCustomer,
			}),
		});
	} catch (error) {
		ctx.logger.error(
			`[sendAutoTopupSucceededWebhook] Failed to send webhook: ${error}`,
			{ error },
		);
	}
};
