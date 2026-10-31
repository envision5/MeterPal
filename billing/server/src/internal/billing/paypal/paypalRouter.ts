// billing/server/src/internal/billing/paypal/paypalRouter.ts
//
// PayPal-specific MeterPal API routes:
//   POST /v1/overage_invoices — create + send a PayPal invoice for AI-usage
//   overage.  The INVOICING.INVOICE.PAID webhook credits the wallet when the
//   buyer pays (idempotent on invoice id).

import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { customers, RecaseError, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import { createInvoice, sendInvoice } from "@/external/paypal/invoicing.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { Hono } from "hono";

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
});

export const handleCreateOverageInvoice = createRoute({
	scopes: [Scopes.Billing.Write],
	body: CreateOverageInvoiceParamsSchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const params = c.req.valid("json");

		const [customer] = await ctx.db
			.select()
			.from(customers)
			.where(
				and(
					eq(customers.id, params.customer_id),
					eq(customers.org_id, ctx.org.id),
					eq(customers.env, ctx.env),
				),
			)
			.limit(1);

		if (!customer) {
			throw new RecaseError({
				message: `Customer ${params.customer_id} not found`,
				statusCode: 404,
			});
		}
		if (!customer.email) {
			throw new RecaseError({
				message: `Customer ${params.customer_id} has no email — PayPal invoicing requires a recipient email`,
				statusCode: 400,
			});
		}

		const invoice = await createInvoice({
			reference: `mp:${customer.id}`,
			recipientEmail: customer.email,
			recipientName: customer.name ?? undefined,
			billerBusinessName: ctx.org.name ?? "MeterPal",
			itemName: params.item_name ?? "AI usage overage",
			amountUsd: params.amount_usd,
			note: params.note,
			memo: params.memo ?? `MeterPal AI usage overage for ${customer.id}`,
		});

		const sent = await sendInvoice(invoice.id);

		return c.json({
			invoice_id: sent.id,
			status: sent.status,
			amount_usd: params.amount_usd,
			customer_id: customer.id,
		});
	},
});

export const paypalRouter = new Hono<HonoEnv>();
paypalRouter.post("/overage_invoices", ...handleCreateOverageInvoice);
