import { type InsertDbInvoiceLineItem, invoiceLineItems } from "@autumn/shared";
import { buildConflictUpdateColumns } from "@/db/dbUtils.js";
import type { DrizzleCli } from "@/db/initDrizzle";

/**
 * Upserts invoice line items by processor_id.
 * For items with a processor_id, uses ON CONFLICT DO UPDATE on the processor_id unique index.
 * For items without a processor_id (null), falls back to plain insert.
 */
export const upsertMany = async ({
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

	// Upsert items with processor_id (can conflict on unique index)
	if (itemsWithProcessorId.length > 0) {
		const updateColumns = buildConflictUpdateColumns(invoiceLineItems, [
			"id",
			"created_at",
		]);

		for (const lineItem of itemsWithProcessorId) {
			await db.insert(invoiceLineItems).values(lineItem).onConflictDoUpdate({
				target: invoiceLineItems.processor_id,
				set: updateColumns,
			});
		}
	}

	// Plain insert for items without processor_id (no conflict possible)
	if (itemsWithoutProcessorId.length > 0) {
		await db.insert(invoiceLineItems).values(itemsWithoutProcessorId);
	}
};
