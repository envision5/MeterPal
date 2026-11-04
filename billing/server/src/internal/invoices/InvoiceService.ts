import {
	type ApiInvoiceV1,
	type Customer,
	customers,
	ErrCode,
	entities,
	type Feature,
	type InsertInvoice,
	type Invoice,
	type InvoiceStatus,
	invoices,
	type ListInvoicesParams,
	type Organization,
	ProcessorType,
	RecaseError,
	StandardCursor,
} from "@autumn/shared";
import type { DrizzleCli } from "@server/db/initDrizzle.js";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { resolvedProductIdsForColumn } from "./repos/utils/resolvedProductIdsSql.js";

export const processInvoice = ({
	invoice,
	withItems = false,
	features,
}: {
	invoice: Invoice;
	withItems?: boolean;
	features?: Feature[];
}): ApiInvoiceV1 => {
	const processorType = invoice.processor_type ?? ProcessorType.PayPal;

	return {
		// Current ids from the hydration query; snapshot if nothing resolved.
		plan_ids: invoice.resolved_product_ids?.length
			? invoice.resolved_product_ids
			: (invoice.product_ids ?? []),
		processor_invoice_id: invoice.processor_invoice_id,
		processor_type: processorType,
		status: invoice.status ?? "",
		total: invoice.total,
		currency: invoice.currency,
		created_at: invoice.created_at,
		hosted_invoice_url: invoice.hosted_invoice_url,
	};
};

export type InvoiceListRow = {
	invoice: Invoice;
	customer_id: string | null;
	entity_id: string | null;
};

const selectListRows = ({ db }: { db: DrizzleCli }) =>
	db
		.select({
			invoice: invoices,
			resolved_product_ids: resolvedProductIdsForColumn({
				internalProductIds: invoices.internal_product_ids,
				productIds: invoices.product_ids,
			}),
			customer_id: customers.id,
			entity_id: entities.id,
		})
		.from(invoices)
		.innerJoin(
			customers,
			eq(invoices.internal_customer_id, customers.internal_id),
		)
		.leftJoin(entities, eq(invoices.internal_entity_id, entities.internal_id));

const toListRow = (
	row: Awaited<
		ReturnType<ReturnType<typeof selectListRows>["execute"]>
	>[number],
): InvoiceListRow => ({
	invoice: {
		...row.invoice,
		resolved_product_ids: row.resolved_product_ids,
	} as Invoice,
	customer_id: row.customer_id,
	entity_id: row.entity_id,
});

export class InvoiceService {
	static async getListRowById({
		ctx,
		id,
	}: {
		ctx: AutumnContext;
		id: string;
	}): Promise<InvoiceListRow | null> {
		const [row] = await selectListRows({ db: ctx.db })
			.where(
				and(
					eq(invoices.id, id),
					eq(customers.org_id, ctx.org.id),
					eq(customers.env, ctx.env),
				),
			)
			.limit(1);
		return row ? toListRow(row) : null;
	}

	static async get({ db, id }: { db: DrizzleCli; id: string }) {
		return (await db.query.invoices.findFirst({
			where: eq(invoices.id, id),
			with: {
				customer: {
					with: {
						org: {
							with: {
								master: true,
							},
						},
					},
				},
			},
		})) as unknown as Invoice & {
			customer: Customer & { org: Organization & { master: Organization } };
		};
	}

	static async getMany({ db, ids }: { db: DrizzleCli; ids: string[] }) {
		return (await db.query.invoices.findMany({
			where: inArray(invoices.id, ids),
			with: {
				customer: {
					with: {
						org: {
							with: {
								master: true,
							},
						},
					},
				},
			},
		})) as unknown as (Invoice & {
			customer: Customer & { org: Organization & { master: Organization } };
		})[];
	}

	static async getCursorPage({
		ctx,
		query,
	}: {
		ctx: AutumnContext;
		query: ListInvoicesParams;
	}): Promise<{
		rows: InvoiceListRow[];
		nextCursor: string | null;
	}> {
		const cursor = StandardCursor.decode(query.start_cursor);

		const conditions = [
			eq(customers.org_id, ctx.org.id),
			eq(customers.env, ctx.env),
		];

		if (query.customer_id) {
			conditions.push(eq(customers.id, query.customer_id));
		}
		if (query.entity_id) {
			conditions.push(eq(entities.id, query.entity_id));
		}
		if (query.status?.length) {
			conditions.push(inArray(invoices.status, query.status));
		}
		if (query.processor_types?.length) {
			conditions.push(
				inArray(invoices.processor_type, query.processor_types),
			);
		}
		if (cursor) {
			conditions.push(
				sql`(${invoices.created_at}, ${invoices.id}) < (${cursor.t}, ${cursor.id})`,
			);
		}

		const results = await selectListRows({ db: ctx.db })
			.where(and(...conditions))
			.orderBy(desc(invoices.created_at), desc(invoices.id))
			.limit(query.limit + 1);

		const hasMore = results.length > query.limit;
		const rows = (hasMore ? results.slice(0, query.limit) : results).map(
			toListRow,
		);

		const last = rows[rows.length - 1];
		const nextCursor =
			hasMore && last
				? StandardCursor.encode({
						id: last.invoice.id,
						t: last.invoice.created_at,
					})
				: null;

		return { rows, nextCursor };
	}

	static async assertOwnership({
		ctx,
		id,
		customerId,
	}: {
		ctx: AutumnContext;
		id: string | string[];
		customerId?: string;
	}) {
		const invoices = await InvoiceService.getMany({
			db: ctx.db,
			ids: Array.isArray(id) ? id : [id],
		});

		if (invoices.length === 0) {
			throw new RecaseError({
				message: `Invoices not found`,
				code: ErrCode.InvalidRequest,
				statusCode: 400,
			});
		}

		invoices.forEach((invoice) => {
			if (invoice.customer.org.id !== ctx.org.id) {
				throw new RecaseError({
					message: `Invoice ${invoice.id} not owned by this organization`,
					code: ErrCode.InvalidRequest,
					statusCode: 400,
				});
			}

			if (customerId && invoice.customer.id !== customerId) {
				throw new RecaseError({
					message: `Invoice ${invoice.id} not owned by this customer`,
					code: ErrCode.InvalidRequest,
					statusCode: 400,
				});
			}
		});

		return true;
	}

	static async list({
		db,
		internalCustomerId,
		internalEntityId,
		limit = 100,
	}: {
		db: DrizzleCli;
		internalCustomerId: string;
		internalEntityId?: string;
		limit?: number;
	}) {
		const rows = await db
			.select({
				invoice: invoices,
				resolved_product_ids: resolvedProductIdsForColumn({
					internalProductIds: invoices.internal_product_ids,
					productIds: invoices.product_ids,
				}),
			})
			.from(invoices)
			.where(
				and(
					eq(invoices.internal_customer_id, internalCustomerId),
					internalEntityId
						? or(
								eq(invoices.internal_entity_id, internalEntityId),
								sql`${invoices.internal_entity_id} IS NULL`,
							)
						: undefined,
				),
			)
			.orderBy(desc(invoices.created_at), desc(invoices.id))
			.limit(limit);

		return rows.map((row) => ({
			...row.invoice,
			resolved_product_ids: row.resolved_product_ids,
		})) as Invoice[];
	}

	static async getByProcessorInvoiceId({
		db,
		processorInvoiceId,
	}: {
		db: DrizzleCli;
		processorInvoiceId: string;
	}) {
		const invoice = await db.query.invoices.findFirst({
			where: eq(invoices.processor_invoice_id, processorInvoiceId),
		});

		if (!invoice) {
			return null;
		}

		return invoice as Invoice;
	}

	static async update({
		db,
		query,
		updates,
	}: {
		db: DrizzleCli;
		query: {
			id?: string;
			processorInvoiceId?: string;
		};
		updates: Partial<InsertInvoice>;
	}) {
		const results = await db
			.update(invoices)
			.set(updates)
			.where(
				and(
					query.id ? eq(invoices.id, query.id) : undefined,
					query.processorInvoiceId
						? eq(invoices.processor_invoice_id, query.processorInvoiceId)
						: undefined,
				),
			)
			.returning();

		if (results.length === 0) return null;

		return results[0] as Invoice;
	}

	static async upsert({
		db,
		invoice,
	}: {
		db: DrizzleCli;
		invoice: InsertInvoice;
	}) {
		const result = await db
			.insert(invoices)
			.values(invoice)
			.onConflictDoUpdate({
				target: invoices.processor_invoice_id,
				set: {
					status: invoice.status,
					hosted_invoice_url: invoice.hosted_invoice_url,
					discounts: invoice.discounts,
					total: invoice.total,
					amount_paid: invoice.amount_paid,
					product_ids: invoice.product_ids?.length
						? sql`CASE
							WHEN ${invoices.product_ids} IS NULL OR cardinality(${invoices.product_ids}) = 0
							THEN excluded.product_ids
							ELSE ${invoices.product_ids}
						END`
						: undefined,
					internal_product_ids: invoice.internal_product_ids?.length
						? sql`CASE
							WHEN ${invoices.internal_product_ids} IS NULL OR cardinality(${invoices.internal_product_ids}) = 0
							THEN excluded.internal_product_ids
							ELSE ${invoices.internal_product_ids}
						END`
						: undefined,
				},
			})
			.returning();

		if (result.length === 0) {
			return undefined;
		}

		return result[0] as Invoice;
	}
}
