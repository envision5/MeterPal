import type { DeferredAutumnBillingPlanData } from "@autumn/shared";
import {
	InvoiceStatus,
	invoices,
	type Metadata,
	MetadataType,
	metadata,
} from "@autumn/shared";
import { and, asc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { withStatementTimeout } from "@/db/withStatementTimeout.js";
import { resolveRedisV2 } from "@/external/redis/resolveRedisV2.js";
import { expirePendingCustomerProducts } from "@/internal/billing/v2/execute/pendingCustomerProducts/expirePendingCustomerProducts";
import { OrgService } from "@/internal/orgs/OrgService";
import type { AttachParams } from "../../internal/customers/cusProducts/AttachParams";
import { MetadataService } from "../../internal/metadata/MetadataService";
import type { CronContext } from "../utils/CronContext";

const getOrgAndCustomerFromMetadata = async ({
	ctx,
	metadata,
}: {
	ctx: CronContext;
	metadata: Metadata;
}) => {
	const { db } = ctx;
	const data = metadata.data as AttachParams | DeferredAutumnBillingPlanData;
	if ("org" in data) {
		return { org: data.org, customer: data.customer };
	} else if ("orgId" in data) {
		const { orgId, env } = data;
		const orgWithFeatures = await OrgService.getWithFeatures({
			db,
			orgId,
			env,
			allowNotFound: true,
		});

		return {
			org: orgWithFeatures?.org,
			customer: data.billingContext?.fullCustomer,
		};
	}

	return { org: undefined, customer: undefined };
};

/**
 * Cleans up invoice-related metadata rows whose expiry has passed.
 *
 * The processor invoice is read from the DB mirror (`invoices`), not from the
 * processor: a paid invoice keeps its metadata row (the customer was billed),
 * an unpaid one is cleaned up together with the plan it was holding.
 *
 * Covers the checkout-invoice, invoice-action-required and deferred-invoice
 * metadata rows: all of them hold a pending plan that must be released when
 * the invoice is never collected.
 */
export const handleVoidInvoiceCron = async ({
	ctx,
	metadata,
}: {
	ctx: CronContext;
	metadata: Metadata;
}) => {
	const { logger, db } = ctx;

	const { org, customer } = await getOrgAndCustomerFromMetadata({
		ctx,
		metadata,
	});
	if (!org || !customer) return;

	const processorInvoiceId = metadata.processor_invoice_id;
	if (!processorInvoiceId) return;

	const expirePendingRows = async () => {
		try {
			await expirePendingCustomerProducts({
				ctx: {
					db,
					logger,
					org: { id: org.id },
					env: customer.env,
					redisV2: resolveRedisV2(),
				},
				metadataId: metadata.id,
			});
		} catch (error) {
			logger.error(`Error expiring pending customer products: ${error}`);
		}
	};

	const [invoice] = await db
		.select({ status: invoices.status })
		.from(invoices)
		.where(eq(invoices.processor_invoice_id, processorInvoiceId))
		.limit(1);

	console.log(
		`Invoice: ${processorInvoiceId} for customer ${customer.id} (org: ${org.slug}) - status: ${invoice?.status ?? "unknown"}`,
	);

	// A paid invoice was collected — leave the metadata row alone.
	if (invoice?.status === InvoiceStatus.Paid) return;

	await expirePendingRows();
	await MetadataService.delete({
		db,
		id: metadata.id,
	});
	logger.info(
		`Cleaned up unpaid invoice ${processorInvoiceId} for customer ${customer.id} (org: ${org.slug})`,
	);
};

export const getExpiredInvoiceMetadata = async ({
	db,
	now,
	limit,
	cursor,
}: {
	db: CronContext["db"];
	now: number;
	limit: number;
	cursor: { expiresAt: number; id: string } | null;
}) => {
	// Keyset over (expires_at, id) so each page is a bounded query: an
	// unbounded SELECT * over a large expired backlog pins xmin while it ships.
	return withStatementTimeout(db, async (tx) =>
		tx
			.select()
			.from(metadata)
			.where(
				and(
					or(
						eq(metadata.type, MetadataType.InvoiceActionRequired),
						eq(metadata.type, MetadataType.InvoiceCheckout),
						eq(metadata.type, MetadataType.DeferredInvoice),
					),
					isNotNull(metadata.expires_at),
					lt(metadata.expires_at, now),
					isNotNull(metadata.processor_invoice_id),
					cursor
						? sql`(${metadata.expires_at}, ${metadata.id} COLLATE "C") > (${cursor.expiresAt}, ${cursor.id})`
						: undefined,
				),
			)
			.orderBy(asc(metadata.expires_at), sql`${metadata.id} COLLATE "C"`)
			.limit(limit),
	);
};

export const runInvoiceCron = async ({ ctx }: { ctx: CronContext }) => {
	try {
		console.log("Running invoice cron");
		const { db } = ctx;

		const now = Date.now();
		const pageSize = 500;
		const maxIterations = 20;
		const concurrency = 50;

		let cursor: { expiresAt: number; id: string } | null = null;
		let total = 0;

		for (let iteration = 0; iteration < maxIterations; iteration++) {
			const invoices = await getExpiredInvoiceMetadata({
				db,
				now,
				limit: pageSize,
				cursor,
			});
			if (invoices.length === 0) break;

			for (let i = 0; i < invoices.length; i += concurrency) {
				const batch = invoices.slice(i, i + concurrency);
				await Promise.all(
					batch.map((item) => handleVoidInvoiceCron({ ctx, metadata: item })),
				);
			}

			total += invoices.length;
			const last = invoices[invoices.length - 1];
			cursor = { expiresAt: Number(last.expires_at), id: last.id };

			if (invoices.length < pageSize) break;
		}

		if (total >= pageSize * maxIterations) {
			console.warn(
				`INVOICE CRON: hit maxIterations (${maxIterations}); backlog likely exceeds ${pageSize * maxIterations}, more runs needed — processed ${total}`,
			);
		}
		console.log(`FINISHED INVOICE CRON: processed ${total}`);
	} catch (error) {
		console.error("Error running invoice cron:", error);
		return;
	}
};
