import { z } from "zod/v4";

export const InvoiceLineItemDiscountSchema = z.object({
	amount_off: z.number(),
	percent_off: z.number().optional(),
});

export const InvoiceLineItemEntitySchema = z.object({
	entity_id: z.string(),
	quantity: z.number().nullable(),
	amount: z.number(),
});

export const InvoiceLineItemSchema = z.object({
	id: z.string(),
	created_at: z.number(),
	invoice_id: z.string().nullable(),

	// Processor identifiers
	processor_id: z.string().nullable(),
	processor_invoice_id: z.string().nullable(),

	// Amounts
	amount: z.number(),
	amount_after_discounts: z.number(),
	currency: z.string(),

	// Quantities
	raw_quantity: z.number().nullable(),
	total_quantity: z.number().nullable(),
	paid_quantity: z.number().nullable(),

	// Description & metadata
	description: z.string(),
	description_source: z.enum(["paypal", "autumn"]).nullable(),
	direction: z.enum(["charge", "refund"]),
	billing_timing: z.enum(["in_advance", "in_arrear"]).nullable(),
	prorated: z.boolean(),

	// Autumn entity relationships
	price_id: z.string().nullable(),
	customer_product_ids: z.array(z.string()), // Array for multi-entity support
	customer_price_ids: z.array(z.string()), // Array for multi-entity support
	customer_entitlement_ids: z.array(z.string()), // Array for multi-entity support
	internal_product_id: z.string().nullable(),
	product_id: z.string().nullable(),
	internal_feature_id: z.string().nullable(),
	feature_id: z.string().nullable(),

	// Billing periods
	effective_period_start: z.number().nullable(),
	effective_period_end: z.number().nullable(),

	// Discounts
	discounts: z.array(InvoiceLineItemDiscountSchema),

	// Per-entity attribution of this line (empty for customer-level lines)
	entities: z.array(InvoiceLineItemEntitySchema),
});

export type InvoiceLineItem = z.infer<typeof InvoiceLineItemSchema>;
export type InvoiceLineItemEntity = z.infer<typeof InvoiceLineItemEntitySchema>;
export type InvoiceLineItemDiscount = z.infer<
	typeof InvoiceLineItemDiscountSchema
>;
