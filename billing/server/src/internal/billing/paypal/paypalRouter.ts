// billing/server/src/internal/billing/paypal/paypalRouter.ts
//
// PayPal-specific MeterPal API routes:
//   POST /v1/overage_invoices                     — create + send a PayPal invoice
//   GET  /v1/overage_invoices/:invoice_id         — re-sync one invoice from PayPal
//   POST /v1/overage_invoices/:invoice_id/remind  — remind the payer
//   POST /v1/overage_invoices/:invoice_id/cancel  — cancel an unpaid invoice
//   POST /v1/overage_invoices/:invoice_id/refund  — record a refund + claw back credits
//
// The invoices row is written when the invoice is SENT, not when it is paid —
// a merchant has to see what they billed the moment they bill it. The
// INVOICING.INVOICE.PAID webhook then flips that row to paid and credits the
// wallet (idempotent on invoice id).

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod/v4";
import {
	customers,
	type DbCustomer,
	InvoiceStatus,
	RecaseError,
	Scopes,
} from "@autumn/shared";
import {
	cancelInvoice,
	createInvoice,
	getInvoice,
	invoiceTotalUsd,
	paidAmountUsd,
	recipientViewUrl,
	recordInvoiceRefund,
	remindInvoice,
	sendInvoice,
} from "@/external/paypal/invoicing.js";
import {
	paypalInvoiceLedgerKey,
	paypalInvoiceRefId,
	recordPaypalInvoice,
} from "@/external/paypal/invoiceRecording.js";
import { getPaypalClient } from "@/external/paypal/paypalClient.js";
import { grantWalletCredits } from "@/external/paypal/runPaypalWebhookHandlers.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import { InvoiceService } from "@/internal/invoices/InvoiceService.js";
import { invalidateCachedFullSubject } from "@/internal/customers/cache/fullSubject/index.js";

export const CreateOverageInvoiceParamsSchema = z.object({
	customer_id: z.string().meta({ description: "MeterPal customer id" }),
	amount_usd: z.number().positive().meta({
		description: "Overage amount in USD to invoice",
	}),
	item_name: z
		.string()
		.optional()
		.meta({ description: "Line item label (defaults to 'AI usage overage')" }),
	note: z.string().optional(),
	memo: z.string().optional(),
	due_date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.meta({ description: "Due date, ISO YYYY-MM-DD (defaults to net 30)" }),
	idempotency_key: z.string().optional().meta({
		description:
			"Optional PayPal-Request-Id. Send the same value to retry safely; omit it and every call issues a new invoice.",
	}),
});

/** The customer an invoice operation applies to, org/env scoped. */
async function requireCustomer({
	db,
	orgId,
	env,
	customerId,
	requireEmail,
}: {
	db: HonoEnv["Variables"]["ctx"]["db"];
	orgId: string;
	env: string;
	customerId: string;
	requireEmail: boolean;
}): Promise<DbCustomer & { id: string }> {
	const [customer] = await db
		.select()
		.from(customers)
		.where(
			and(
				eq(customers.id, customerId),
				eq(customers.org_id, orgId),
				eq(customers.env, env),
			),
		)
		.limit(1);

	if (!customer || !customer.id) {
		throw new RecaseError({
			message: `Customer ${customerId} not found`,
			statusCode: 404,
		});
	}
	if (requireEmail && !customer.email) {
		throw new RecaseError({
			message: `Customer ${customerId} has no email — PayPal invoicing requires a recipient email`,
			statusCode: 400,
		});
	}
	return customer as DbCustomer & { id: string };
}

/** Path param, narrowed — createRoute types params as possibly undefined. */
function requireInvoiceId(invoiceId: string | undefined): string {
	if (!invoiceId) {
		throw new RecaseError({
			message: "invoice_id is required",
			statusCode: 400,
		});
	}
	return invoiceId;
}

/**
 * Invoice number sent to PayPal.
 *
 * PayPal requires invoice numbers to be unique within an account, so this must
 * NOT be derived from the customer — that hands every invoice a given customer
 * ever receives the same number, and PayPal rejects the second one. The
 * customer is already recorded in `detail.reference` (`mp:<customer_id>`).
 */
function invoiceNumberFor(at = Date.now()): string {
	const stamp = new Date(at).toISOString().slice(0, 10).replace(/-/g, "");
	// base36 of the millisecond clock changes every millisecond; the random
	// tail covers two invoices created inside the same millisecond.
	const seq = (at % 1_679_616).toString(36).toUpperCase().padStart(4, "0");
	const tail = Math.floor(Math.random() * 1296)
		.toString(36)
		.toUpperCase()
		.padStart(2, "0");
	return `MP-${stamp}-${seq}${tail}`;
}

export const handleCreateOverageInvoice = createRoute({
	scopes: [Scopes.Billing.Write],
	body: CreateOverageInvoiceParamsSchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const params = c.req.valid("json");

		const customer = await requireCustomer({
			db: ctx.db,
			orgId: ctx.org.id,
			env: ctx.env,
			customerId: params.customer_id,
			requireEmail: true,
		});

		const client = await getPaypalClient({ org: ctx.org, env: ctx.env });
		const itemName = params.item_name ?? "AI usage overage";

		// 1. Draft. The reference is how the payment webhook finds the customer.
		const draft = await createInvoice({
			client,
			reference: `mp:${customer.id}`,
			recipientEmail: customer.email as string,
			recipientName: customer.name ?? undefined,
			billerBusinessName: ctx.org.name ?? "MeterPal",
			itemName,
			itemDescription: params.memo,
			amountUsd: params.amount_usd,
			note: params.note,
			memo: params.memo ?? `MeterPal AI usage overage for ${customer.id}`,
			invoiceNumber: invoiceNumberFor(),
			dueDateIso: params.due_date,
			// Only dedupe when the CALLER says this is a retry. A key derived
			// from customer+amount would silently block a second legitimate
			// invoice for the same amount for 72h.
			idempotencyKey: params.idempotency_key,
		});

		if (!draft?.id) {
			throw new RecaseError({
				message: "PayPal did not return an invoice id",
				statusCode: 502,
			});
		}

		// 2. Send. PayPal answers with a link, so re-read for real state.
		await sendInvoice(client, draft.id, { sendToInvoicer: false });
		const sent = await getInvoice(client, draft.id);

		// 3. Record it now, so the dashboard shows what was billed.
		await recordPaypalInvoice({
			customer,
			externalId: paypalInvoiceRefId(sent.id),
			amountUsd: invoiceTotalUsd(sent) || params.amount_usd,
			description: itemName,
			status: InvoiceStatus.Open,
			amountPaidUsd: 0,
			hostedInvoiceUrl: recipientViewUrl(sent),
			db: ctx.db,
		});

		await invalidateCachedFullSubject({
			ctx,
			customerId: customer.id,
			source: "paypal:overage-invoice-created",
		}).catch(() => {
			// A stale cache read costs one refetch, not the invoice.
		});

		return c.json({
			invoice_id: sent.id,
			status: sent.status,
			amount_usd: invoiceTotalUsd(sent) || params.amount_usd,
			customer_id: customer.id,
			invoice_number: sent.detail?.invoice_number ?? null,
			due_date: sent.detail?.payment_term?.due_date ?? null,
			hosted_invoice_url: recipientViewUrl(sent),
		});
	},
});

export const handleGetOverageInvoice = createRoute({
	scopes: [Scopes.Billing.Read],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const invoiceId = requireInvoiceId(c.req.param("invoice_id"));
		const client = await getPaypalClient({ org: ctx.org, env: ctx.env });
		const invoice = await getInvoice(client, invoiceId);
		return c.json({
			invoice_id: invoice.id,
			status: invoice.status,
			amount_usd: invoiceTotalUsd(invoice),
			amount_paid_usd: paidAmountUsd(invoice),
			due_amount_usd: Number.parseFloat(invoice.due_amount?.value ?? "0"),
			hosted_invoice_url: recipientViewUrl(invoice),
			reference: invoice.detail?.reference ?? null,
			invoice_number: invoice.detail?.invoice_number ?? null,
			due_date: invoice.detail?.payment_term?.due_date ?? null,
		});
	},
});

export const handleRemindOverageInvoice = createRoute({
	scopes: [Scopes.Billing.Write],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const invoiceId = requireInvoiceId(c.req.param("invoice_id"));
		const client = await getPaypalClient({ org: ctx.org, env: ctx.env });
		await remindInvoice(client, invoiceId);
		return c.json({ invoice_id: invoiceId, reminded: true });
	},
});

export const handleCancelOverageInvoice = createRoute({
	scopes: [Scopes.Billing.Write],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const invoiceId = requireInvoiceId(c.req.param("invoice_id"));
		const client = await getPaypalClient({ org: ctx.org, env: ctx.env });

		await cancelInvoice(client, invoiceId);

		const existing = await InvoiceService.getByProcessorInvoiceId({
			db: ctx.db,
			processorInvoiceId: paypalInvoiceRefId(invoiceId),
		});
		if (existing) {
			await recordPaypalInvoice({
				customer: {
					internal_id: existing.internal_customer_id,
					id: existing.internal_customer_id,
					org_id: ctx.org.id,
					env: ctx.env,
				},
				externalId: paypalInvoiceRefId(invoiceId),
				amountUsd: Number(existing.total) || 0,
				description: existing.items?.[0]?.description ?? "PayPal overage invoice",
				status: InvoiceStatus.Void,
				amountPaidUsd: Number(existing.amount_paid) || 0,
				hostedInvoiceUrl: existing.hosted_invoice_url,
				createdAt: Number(existing.created_at) || Date.now(),
				db: ctx.db,
			});
		}

		return c.json({ invoice_id: invoiceId, status: "CANCELLED" });
	},
});

export const RefundOverageInvoiceParamsSchema = z.object({
	amount_usd: z.number().positive().optional().meta({
		description: "Amount to refund; defaults to the full paid amount",
	}),
	reason: z.string().optional(),
});

export const handleRefundOverageInvoice = createRoute({
	scopes: [Scopes.Billing.Write],
	body: RefundOverageInvoiceParamsSchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const invoiceId = requireInvoiceId(c.req.param("invoice_id"));
		const params = c.req.valid("json");

		const existing = await InvoiceService.getByProcessorInvoiceId({
			db: ctx.db,
			processorInvoiceId: paypalInvoiceRefId(invoiceId),
		});
		if (!existing) {
			throw new RecaseError({
				message: `No recorded invoice for PayPal id ${invoiceId}`,
				statusCode: 404,
			});
		}

		const client = await getPaypalClient({ org: ctx.org, env: ctx.env });
		const invoice = await getInvoice(client, invoiceId);
		const paid = paidAmountUsd(invoice);
		const alreadyRefunded = Number(existing.refunded_amount) || 0;
		const refundable = Math.max(paid - alreadyRefunded, 0);

		if (refundable <= 0) {
			throw new RecaseError({
				message: `Invoice ${invoiceId} has nothing left to refund`,
				statusCode: 400,
			});
		}

		const amount = params.amount_usd ?? refundable;
		if (amount > refundable) {
			throw new RecaseError({
				message: `Refund of ${amount} exceeds the refundable balance of ${refundable}`,
				statusCode: 400,
			});
		}

		const [customer] = await ctx.db
			.select()
			.from(customers)
			.where(eq(customers.internal_id, existing.internal_customer_id))
			.limit(1);
		if (!customer || !customer.id) {
			throw new RecaseError({
				message: "Customer behind this invoice no longer exists",
				statusCode: 404,
			});
		}
		const invoiceCustomer = customer as DbCustomer & { id: string };

		// 1. Tell PayPal, so their records and ours agree.
		const recorded = await recordInvoiceRefund(client, invoiceId, {
			amountUsd: amount,
			note: params.reason,
		});

		// 2. Claw the credits back. Keyed on the refund id so a retry is a
		//    no-op rather than a second debit.
		const refundKey = recorded?.refund_id
			? `paypal-invoice-refund:${recorded.refund_id}`
			: `paypal-invoice-refund:${invoiceId}:${alreadyRefunded + amount}`;
		await grantWalletCredits({
			customer: invoiceCustomer,
			amountUsd: -amount,
			idempotencyKey: refundKey,
			eventName: "invoice_refunded",
			metadata: {
				invoice_id: invoiceId,
				reason: params.reason ?? null,
				ledger_source: paypalInvoiceLedgerKey(invoiceId),
			},
		});

		// 3. Mirror it on the row the dashboard reads.
		const totalRefunded = alreadyRefunded + amount;
		await recordPaypalInvoice({
			customer: invoiceCustomer,
			externalId: paypalInvoiceRefId(invoiceId),
			amountUsd: Number(existing.total) || invoiceTotalUsd(invoice),
			description:
				existing.items?.[0]?.description ?? "PayPal overage invoice",
			status:
				totalRefunded >= (Number(existing.total) || 0)
					? InvoiceStatus.Void
					: InvoiceStatus.Paid,
			amountPaidUsd: paid,
			refundedUsd: totalRefunded,
			hostedInvoiceUrl: existing.hosted_invoice_url,
			createdAt: Number(existing.created_at) || Date.now(),
			db: ctx.db,
		});

		await invalidateCachedFullSubject({
			ctx,
			customerId: invoiceCustomer.id,
			source: "paypal:overage-invoice-refunded",
		}).catch(() => {});

		return c.json({
			invoice_id: invoiceId,
			refund_id: recorded?.refund_id ?? null,
			amount_usd: amount,
			total_refunded_usd: totalRefunded,
		});
	},
});

export const paypalRouter = new Hono<HonoEnv>();
paypalRouter.post("/overage_invoices", ...handleCreateOverageInvoice);
paypalRouter.get("/overage_invoices/:invoice_id", ...handleGetOverageInvoice);
paypalRouter.post(
	"/overage_invoices/:invoice_id/remind",
	...handleRemindOverageInvoice,
);
paypalRouter.post(
	"/overage_invoices/:invoice_id/cancel",
	...handleCancelOverageInvoice,
);
paypalRouter.post(
	"/overage_invoices/:invoice_id/refund",
	...handleRefundOverageInvoice,
);
