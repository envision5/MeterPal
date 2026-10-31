// billing/server/src/external/paypal/invoicing.ts
//
// PayPal Invoicing API v2 wrappers — used for AI-usage overage billing.
// Flow: createInvoice (draft) -> sendInvoice (emails the payer) -> the
// INVOICING.INVOICE.PAID webhook lands in runPaypalWebhookHandlers.ts, which
// credits the wallet (idempotent on invoice id).
//
// Sandbox caveat: emails are delivered only to sandbox accounts, and payment
// recording may be manual (dashboard) — the demo treats INVOICING.INVOICE.PAID
// as the money event either way.
//
// Spec: https://developer.paypal.com/docs/api/invoicing/v2

import { paypalFetch } from "./client.js";

export interface PayPalInvoice {
	id: string;
	status: string;
	detail?: {
		reference?: string;
		currency_code?: string;
		memo?: string;
	};
	amount?: {
		breakdown?: {
			item_total?: { currency_code: string; value: string };
		};
	};
	links?: Array<{ href: string; rel: string; method?: string }>;
}

export interface CreateInvoiceArgs {
	/** Our reference — carries the MeterPal customer id ("mp:<customer_id>"). */
	reference: string;
	recipientEmail: string;
	recipientName?: string;
	billerEmail?: string;
	billerBusinessName?: string;
	itemName: string;
	/** USD amount, major units. */
	amountUsd: number;
	note?: string;
	memo?: string;
	dueDateIso?: string;
	idempotencyKey?: string;
}

export async function createInvoice({
	reference,
	recipientEmail,
	recipientName,
	billerEmail,
	billerBusinessName,
	itemName,
	amountUsd,
	note,
	memo,
	dueDateIso,
	idempotencyKey,
}: CreateInvoiceArgs): Promise<PayPalInvoice> {
	const value = new Intl.NumberFormat("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(amountUsd);

	return paypalFetch<PayPalInvoice>("/v2/invoicing/invoices", {
		method: "POST",
		body: JSON.stringify({
			detail: {
				reference,
				currency_code: "USD",
				...(note ? { note } : {}),
				...(memo ? { memo } : {}),
				...(dueDateIso ? { due_date: dueDateIso } : {}),
			},
			...(billerBusinessName || billerEmail
				? {
						invoicer: {
							...(billerBusinessName ? { business_name: billerBusinessName } : {}),
							...(billerEmail ? { email_address: billerEmail } : {}),
						},
					}
				: {}),
			primary_recipients: [
				{
					billing_info: {
						...(recipientEmail ? { email_address: recipientEmail } : {}),
						...(recipientName
							? { name: { given_name: recipientName } }
							: {}),
					},
				},
			],
			items: [
				{
					name: itemName,
					quantity: "1",
					unit_amount: { currency_code: "USD", value },
				},
			],
			amount: {
				breakdown: { item_total: { currency_code: "USD", value } },
			},
		}),
		idempotencyKey,
	});
}

export async function sendInvoice(invoiceId: string): Promise<PayPalInvoice> {
	return paypalFetch<PayPalInvoice>(
		`/v2/invoicing/invoices/${invoiceId}/send`,
		{
			method: "POST",
			body: JSON.stringify({}),
			headers: { Prefer: "return=representation" },
		},
	);
}

export async function getInvoice(invoiceId: string): Promise<PayPalInvoice> {
	return paypalFetch<PayPalInvoice>(`/v2/invoicing/invoices/${invoiceId}`, {
		method: "GET",
	});
}

export async function listInvoices(params: {
	page?: number;
	pageSize?: number;
} = {}): Promise<{ total_items: number; invoices: PayPalInvoice[] }> {
	const query = new URLSearchParams({
		page: String(params.page ?? 1),
		page_size: String(params.pageSize ?? 25),
	});
	return paypalFetch<{ total_items: number; invoices: PayPalInvoice[] }>(
		`/v2/invoicing/invoices?${query.toString()}`,
		{ method: "GET" },
	);
}
