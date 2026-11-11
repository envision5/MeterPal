// billing/server/src/external/paypal/invoiceRecording.ts
//
// Records a PayPal money event as an invoices row so the merchant sees
// PayPal payments in the dashboard with correct processor attribution.
//
// The invoice's external id (the DB column is named `processor_invoice_id`)
// is namespaced by the PayPal instrument so refunds can resolve
// what they refund later:
//   pp-cap-<captureId>   one-off order capture / merchant-initiated top-up
//   pp-sale-<saleId>     subscription cycle payment (Payments v1 sale)
//   pp-inv-<invoiceId>   PayPal Invoicing API payment
//
// Upsert on processor_invoice_id makes every call idempotent — the capture path
// and the PAYMENT.CAPTURE.COMPLETED webhook can both fire for the same money.

import {
	type AppEnv,
	type DbCustomer,
	type InsertInvoice,
	InvoiceStatus,
	ProcessorType,
	products,
} from "@autumn/shared";
import { and, eq } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import { db as defaultDb } from "@/db/initDrizzle.js";
import { logger as defaultLogger } from "@/external/logtail/logtailUtils.js";
import { InvoiceService } from "@/internal/invoices/InvoiceService.js";
import { generateId } from "@/utils/genUtils.js";

export function paypalCaptureInvoiceId(captureId: string): string {
	return `pp-cap-${captureId}`;
}

export function paypalSaleInvoiceId(saleId: string): string {
	return `pp-sale-${saleId}`;
}

export function paypalInvoiceRefId(invoiceId: string): string {
	return `pp-inv-${invoiceId}`;
}

/**
 * The wallet-ledger idempotency key for an invoice payment.
 *
 * Shared by the webhook that grants the credits and the refund path that has
 * to find the grant again, so a refund can never debit a grant it did not
 * create.
 */
export function paypalInvoiceLedgerKey(invoiceId: string): string {
	return `paypal-invoice:${invoiceId}`;
}

/** The PayPal instrument a `pp-*` invoice id names, or null when it isn't one. */
export function paypalInvoiceInstrument(
	processorInvoiceId: string | null | undefined,
): { instrument: "capture" | "sale" | "invoice"; externalId: string } | null {
	if (!processorInvoiceId?.startsWith("pp-")) return null;
	const rest = processorInvoiceId.slice(3);
	if (rest.startsWith("cap-"))
		return { instrument: "capture", externalId: rest.slice(4) };
	if (rest.startsWith("sale-"))
		return { instrument: "sale", externalId: rest.slice(5) };
	if (rest.startsWith("inv-"))
		return { instrument: "invoice", externalId: rest.slice(4) };
	return null;
}

/** True when an invoice external id names a PayPal money instrument. */
export function isPaypalInvoiceId(
	processorInvoiceId: string | null | undefined,
): boolean {
	return paypalInvoiceInstrument(processorInvoiceId) !== null;
}

/**
 * Insert (or upsert by external id) the invoices row behind a PayPal money
 * event.  Plan attribution is resolved from `productId` when the caller
 * knows it (the order intent row, the subscription's paypal_plan_id).
 */
export const recordPaypalInvoice = async ({
	customer,
	externalId,
	amountUsd,
	productId,
	description,
	status = InvoiceStatus.Paid,
	amountPaidUsd,
	refundedUsd,
	hostedInvoiceUrl,
	createdAt = Date.now(),
	db,
	logger,
}: {
	customer: Pick<DbCustomer, "internal_id" | "id" | "org_id" | "env">;
	/** Namespaced PayPal instrument id — use the paypal*InvoiceId helpers. */
	externalId: string;
	amountUsd: number;
	/** The MeterPal plan the payment was for, when known. */
	productId?: string | null;
	description?: string;
	/** `open` for a sent-but-unpaid invoice, `paid` once the money lands. */
	status?: InvoiceStatus;
	/** Amount actually collected; defaults to the full amount for paid rows. */
	amountPaidUsd?: number;
	refundedUsd?: number;
	/** The payer-facing PayPal URL, so the dashboard can link to it. */
	hostedInvoiceUrl?: string | null;
	createdAt?: number;
	db?: DrizzleCli;
	logger?: typeof defaultLogger;
}): Promise<void> => {
	const log = logger ?? defaultLogger;
	const dbo = db ?? defaultDb;
	if (!amountUsd || Number.isNaN(amountUsd)) return;

	let productIds: string[] = [];
	let internalProductIds: string[] = [];
	if (productId) {
		const [row] = await dbo
			.select({ id: products.id, internalId: products.internal_id })
			.from(products)
			.where(
				and(
					eq(products.id, productId),
					eq(products.org_id, customer.org_id),
					eq(products.env, customer.env as AppEnv),
				),
			)
			.limit(1);
		if (row) {
			productIds = [row.id];
			internalProductIds = [row.internalId];
		}
	}

	const invoice: InsertInvoice = {
		id: generateId("inv"),
		internal_customer_id: customer.internal_id,
		product_ids: productIds,
		internal_product_ids: internalProductIds,
		processor_invoice_id: externalId,
		processor_type: ProcessorType.PayPal,
		status,
		hosted_invoice_url: hostedInvoiceUrl ?? null,
		total: amountUsd,
		amount_paid:
			amountPaidUsd ?? (status === InvoiceStatus.Paid ? amountUsd : 0),
		refunded_amount: refundedUsd ?? 0,
		currency: "usd",
		discounts: [],
		items: description
			? [
					{
						price_id: null,
						processor_id: externalId,
						internal_feature_id: null,
						description: description.slice(0, 200),
						period_start: createdAt,
						period_end: createdAt,
					},
				]
			: [],
		created_at: createdAt,
	};

	await InvoiceService.upsert({ db: dbo, invoice });
	log.info({
		msg: "paypal: recorded invoice",
		externalId,
		amountUsd,
		status,
		customerId: customer.id,
		productId: productId ?? null,
	});
};
