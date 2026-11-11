// billing/server/src/external/paypal/invoicing.ts
//
// PayPal Invoicing API v2 wrappers — used for AI-usage overage billing.
//
// Flow: createInvoice (DRAFT) -> sendInvoice (emails the payer, returns only a
// HATEOAS link) -> getInvoice (authoritative state + the payer's view URL) ->
// the INVOICING.INVOICE.PAID webhook lands in runPaypalWebhookHandlers.ts,
// which credits the wallet (idempotent on invoice id).
//
// Two contract details that are easy to get wrong, and were:
//   1. `POST .../send` responds 200 with a *link* (`{href, rel, method}`), NOT
//      the invoice.  Reading `.id` off it yields undefined.  Callers that need
//      the invoice must re-read it with getInvoice().
//   2. The payer-facing URL lives in `detail.metadata.recipient_view_url`, not
//      in the `links` array.  That is what we store as hosted_invoice_url.
//
// Amounts are strings in PayPal's money type; every value is formatted to two
// decimals here so a float never reaches the wire in exponent or truncated
// form.
//
// Sandbox caveat: emails are delivered only to sandbox accounts, and payment
// recording may be manual (dashboard) — the demo treats INVOICING.INVOICE.PAID
// as the money event either way.
//
// Spec: https://developer.paypal.com/api/invoicing/v2/

import type { PaypalClient } from "./paypalClient.js";

/** Statuses documented for an invoice resource. */
export type PayPalInvoiceStatus =
	| "DRAFT"
	| "SENT"
	| "SCHEDULED"
	| "PAYMENT_PENDING"
	| "PAID"
	| "MARKED_AS_PAID"
	| "PARTIALLY_PAID"
	| "CANCELLED"
	| "REFUNDED"
	| "PARTIALLY_REFUNDED"
	| "MARKED_AS_REFUNDED"
	| "UNPAID"
	| string;

export interface PayPalInvoiceLink {
	href: string;
	rel: string;
	method?: string;
}

export interface PayPalInvoice {
	id: string;
	status: PayPalInvoiceStatus;
	detail?: {
		reference?: string;
		currency_code?: string;
		memo?: string;
		note?: string;
		invoice_number?: string;
		invoice_date?: string;
		payment_term?: { term_type?: string; due_date?: string };
		metadata?: {
			create_time?: string;
			recipient_view_url?: string;
			invoicer_view_url?: string;
		};
	};
	amount?: {
		currency_code?: string;
		value?: string;
		breakdown?: {
			item_total?: { currency_code: string; value: string };
		};
	};
	due_amount?: { currency_code?: string; value?: string };
	primary_recipients?: Array<{
		billing_info?: { email_address?: string };
	}>;
	payments?: {
		paid_amount?: { currency_code?: string; value?: string };
		transactions?: Array<{
			id?: string;
			type?: string;
			method?: string;
			amount?: { currency_code?: string; value?: string };
		}>;
	};
	links?: PayPalInvoiceLink[];
}

/** What `POST .../send` actually returns: a HATEOAS link, not an invoice. */
export interface PayPalSendResult {
	href: string;
	rel: string;
	method?: string;
}

/** Money values are strings in PayPal's REST convention. */
function moneyValue(amountUsd: number): string {
	return new Intl.NumberFormat("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
		useGrouping: false,
	}).format(amountUsd);
}

function parseUsd(value: string | undefined | null): number {
	if (!value) return 0;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** ISO date (no time) — PayPal's `date_no_time` type. */
function isoDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export interface CreateInvoiceArgs {
	client: PaypalClient;
	/** Our reference — carries the MeterPal customer id ("mp:<customer_id>"). */
	reference: string;
	recipientEmail: string;
	recipientName?: string;
	billerEmail?: string;
	billerBusinessName?: string;
	itemName: string;
	itemDescription?: string;
	/** USD amount, major units. */
	amountUsd: number;
	note?: string;
	memo?: string;
	/** Merchant-facing invoice number; PayPal generates one when omitted. */
	invoiceNumber?: string;
	/** Net terms. Defaults to NET_30 from the invoice date. */
	dueDateIso?: string;
	/** PayPal-Request-Id — deduped by PayPal for 72h. */
	idempotencyKey?: string;
	/** Defaults to today. */
	invoiceDateIso?: string;
}

export async function createInvoice({
	client,
	reference,
	recipientEmail,
	recipientName,
	billerEmail,
	billerBusinessName,
	itemName,
	itemDescription,
	amountUsd,
	note,
	memo,
	invoiceNumber,
	dueDateIso,
	idempotencyKey,
	invoiceDateIso,
}: CreateInvoiceArgs): Promise<PayPalInvoice> {
	const value = moneyValue(amountUsd);
	const invoiceDate = invoiceDateIso ?? isoDate(Date.now());
	const dueDate =
		dueDateIso ?? isoDate(Date.now() + 30 * 24 * 60 * 60 * 1000);

	return client.fetch<PayPalInvoice>("/v2/invoicing/invoices", {
		method: "POST",
		idempotencyKey,
		body: JSON.stringify({
			detail: {
				reference,
				currency_code: "USD",
				invoice_date: invoiceDate,
				...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
				// PayPal requires due_date when payment_term is present, and
				// validates term_type against it.
				payment_term: { term_type: "NET_30", due_date: dueDate },
				...(note ? { note } : {}),
				...(memo ? { memo } : {}),
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
					...(itemDescription ? { description: itemDescription } : {}),
					quantity: "1",
					unit_amount: { currency_code: "USD", value },
				},
			],
			amount: {
				breakdown: { item_total: { currency_code: "USD", value } },
			},
		}),
	});
}

/**
 * Send (or schedule) an invoice.
 *
 * Returns the HATEOAS link PayPal responds with — NOT the invoice. Use
 * getInvoice() afterwards for status and the payer view URL.
 */
export async function sendInvoice(
	client: PaypalClient,
	invoiceId: string,
	opts: { sendToInvoicer?: boolean; sendToRecipient?: boolean } = {},
): Promise<PayPalSendResult> {
	return client.fetch<PayPalSendResult>(
		`/v2/invoicing/invoices/${invoiceId}/send`,
		{
			method: "POST",
			body: JSON.stringify({
				send_to_invoicer: opts.sendToInvoicer ?? false,
				send_to_recipient: opts.sendToRecipient ?? true,
			}),
		},
	);
}

export async function getInvoice(
	client: PaypalClient,
	invoiceId: string,
): Promise<PayPalInvoice> {
	return client.fetch<PayPalInvoice>(`/v2/invoicing/invoices/${invoiceId}`, {
		method: "GET",
	});
}

export async function listInvoices(
	client: PaypalClient,
	params: {
		page?: number;
		pageSize?: number;
		totalRequired?: boolean;
	} = {},
): Promise<{
	total_items?: number;
	total_pages?: number;
	items?: PayPalInvoice[];
}> {
	const query = new URLSearchParams({
		page: String(params.page ?? 1),
		page_size: String(params.pageSize ?? 25),
		total_required: String(params.totalRequired ?? true),
	});
	return client.fetch(`/v2/invoicing/invoices?${query.toString()}`, {
		method: "GET",
	});
}

/** Remind the payer about an outstanding invoice. */
export async function remindInvoice(
	client: PaypalClient,
	invoiceId: string,
): Promise<void> {
	await client.fetch(`/v2/invoicing/invoices/${invoiceId}/remind`, {
		method: "POST",
		body: JSON.stringify({}),
	});
}

/** Cancel a sent invoice. No-op for an already-paid one (PayPal 422). */
export async function cancelInvoice(
	client: PaypalClient,
	invoiceId: string,
	opts: { sendToInvoicer?: boolean; sendToRecipient?: boolean } = {},
): Promise<void> {
	await client.fetch(`/v2/invoicing/invoices/${invoiceId}/cancel`, {
		method: "POST",
		body: JSON.stringify({
			send_to_invoicer: opts.sendToInvoicer ?? false,
			send_to_recipient: opts.sendToRecipient ?? false,
		}),
	});
}

/**
 * Record a refund against an invoice.
 *
 * `method: "PAYPAL"` is for money returned through PayPal itself; the API only
 * records it, the actual funds movement happens on the capture/sale.
 */
export async function recordInvoiceRefund(
	client: PaypalClient,
	invoiceId: string,
	args: {
		amountUsd: number;
		refundDateIso?: string;
		method?: "PAYPAL" | "OTHER";
		note?: string;
	},
): Promise<{ refund_id?: string }> {
	return client.fetch<{ refund_id?: string }>(
		`/v2/invoicing/invoices/${invoiceId}/refunds`,
		{
			method: "POST",
			body: JSON.stringify({
				method: args.method ?? "PAYPAL",
				refund_date: args.refundDateIso ?? isoDate(Date.now()),
				amount: { currency_code: "USD", value: moneyValue(args.amountUsd) },
				...(args.note ? { note: args.note } : {}),
			}),
		},
	);
}

/** The payer-facing URL for an invoice, from whichever field carries it. */
export function recipientViewUrl(
	invoice: PayPalInvoice | null | undefined,
): string | null {
	if (!invoice) return null;
	return (
		invoice.detail?.metadata?.recipient_view_url ??
		invoice.links?.find((l) => l.rel === "payer-view")?.href ??
		null
	);
}

/** Invoice total in USD, from the total or the item breakdown. */
export function invoiceTotalUsd(invoice: PayPalInvoice): number {
	return parseUsd(
		invoice.amount?.value ?? invoice.amount?.breakdown?.item_total?.value,
	);
}

/**
 * How much of an invoice has actually been paid, in USD.
 *
 * `INVOICING.INVOICE.PAID` fires for a full payment, a partial payment AND a
 * pending payment, so the status has to be consulted — crediting the invoice
 * total on every PAID event over-grants on partials and grants on money that
 * has not settled.
 *
 * Refunded statuses still count as paid: the money did arrive, and the
 * clawback is a separate negative grant driven by the refund path.
 */
export function paidAmountUsd(invoice: PayPalInvoice): number {
	const total = invoiceTotalUsd(invoice);
	const due = parseUsd(invoice.due_amount?.value);
	switch (invoice.status) {
		case "PAID":
		case "MARKED_AS_PAID":
		case "REFUNDED":
		case "PARTIALLY_REFUNDED":
		case "MARKED_AS_REFUNDED":
			return total;
		case "PARTIALLY_PAID":
			return Math.max(total - due, 0);
		default:
			// PAYMENT_PENDING, UNPAID, DRAFT, ... — no settled money yet.
			return 0;
	}
}

/** True when the status means money has settled (fully or partially). */
export function isSettledStatus(status: PayPalInvoiceStatus): boolean {
	return (
		status === "PAID" ||
		status === "MARKED_AS_PAID" ||
		status === "PARTIALLY_PAID" ||
		status === "REFUNDED" ||
		status === "PARTIALLY_REFUNDED" ||
		status === "MARKED_AS_REFUNDED"
	);
}
