import { type InsertDbInvoiceLineItem, invoiceLineItems } from "@autumn/shared";
import { sql } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle";

/**
 * Reconciles invoice line items by processor_id with partial updates.
 *
 * For existing rows (matched by processor_id): Updates only processor-authoritative
 * fields, preserving Autumn metadata (product_id, feature_id, billing_timing, etc.).
 *
 * For new rows (no matching processor_id): Inserts the full row.
 *
 * Processor-authoritative fields (updated):
 * - amount, amount_after_discounts, currency
 * - raw_quantity
 * - discounts
 * - effective_period_start, effective_period_end
 * - description (only when description_source = "processor")
 *
 * Autumn-authoritative fields (preserved):
 * - total_quantity, paid_quantity (computed from billing_units, not raw packs)
 * - product_id, internal_product_id
 * - feature_id, internal_feature_id
 * - price_id, billing_timing, direction, prorated
 * - customer_product_ids, customer_price_ids, customer_entitlement_ids
 * - entities
 * - description_source
 */
export const reconcileMany = async ({
	db,
	lineItems,
}: {
	db: DrizzleCli;
	lineItems: InsertDbInvoiceLineItem[];
}): Promise<void> => {
	if (lineItems.length === 0) return;

	// Separate items with and without processor_id
	const itemsWithProcessorId = lineItems.filter((li) => li.processor_id != null);
	const itemsWithoutProcessorId = lineItems.filter(
		(li) => li.processor_id == null,
	);

	// Partial upsert for items with processor_id
	// Only update processor-authoritative fields, preserve Autumn metadata
	if (itemsWithProcessorId.length > 0) {
		for (const lineItem of itemsWithProcessorId) {
			await db
				.insert(invoiceLineItems)
				.values(lineItem)
				.onConflictDoUpdate({
					target: invoiceLineItems.processor_id,
					set: {
						// Processor-authoritative: amounts
						amount: sql`excluded.amount`,
						amount_after_discounts: sql`excluded.amount_after_discounts`,
						currency: sql`excluded.currency`,

						// Processor-authoritative: quantities (only raw_quantity)
						// Note: total_quantity and paid_quantity are Autumn-authoritative
						// (computed from billing_units), so they are NOT updated here
						raw_quantity: sql`excluded.raw_quantity`,

						// Processor-authoritative: discounts
						discounts: sql`excluded.discounts`,

						// Processor-authoritative: period
						effective_period_start: sql`excluded.effective_period_start`,
						effective_period_end: sql`excluded.effective_period_end`,

						// Description: only update if incoming source is "processor"
						// This preserves Autumn-sourced descriptions
						description: sql`CASE
							WHEN excluded.description_source = 'processor' THEN excluded.description
							ELSE ${invoiceLineItems.description}
						END`,

						// Note: All Autumn-authoritative fields are intentionally NOT updated:
						// - product_id, internal_product_id
						// - feature_id, internal_feature_id
						// - price_id, billing_timing, direction, prorated
						// - customer_product_ids, customer_price_ids, customer_entitlement_ids, entities
						// - description_source
					},
				});
		}
	}

	// Plain insert for items without processor_id (no conflict possible)
	if (itemsWithoutProcessorId.length > 0) {
		await db.insert(invoiceLineItems).values(itemsWithoutProcessorId);
	}
};
