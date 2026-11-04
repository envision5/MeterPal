import type { AppEnv, Metadata } from "@autumn/shared";
import { invoices, InvoiceStatus } from "@autumn/shared";
import { eq } from "drizzle-orm";
import type { RepoContext } from "@/db/repoContext";
import { resolveRedisV2 } from "@/external/redis/resolveRedisV2.js";
import { expirePendingCustomerProducts } from "@/internal/billing/v2/execute/pendingCustomerProducts/expirePendingCustomerProducts";
import { MetadataService } from "@/internal/metadata/MetadataService";

/**
 * A deferred invoice reached its due date: give up the pending plan unless
 * anything was paid.
 *
 * The processor invoice is read from the DB mirror (`invoices`), not from the
 * processor: a paid invoice keeps the pending plan, an unpaid one is cleaned up
 * together with the plan it was holding.
 */
export const expirePendingPlanAtDueDate = async ({
	ctx,
	orgId,
	env,
	metadata,
}: {
	ctx: Pick<RepoContext, "db" | "logger">;
	orgId: string;
	env: AppEnv;
	metadata: Metadata;
}) => {
	const repoContext: RepoContext = {
		...ctx,
		org: { id: orgId },
		env,
		redisV2: resolveRedisV2(),
	};

	try {
		const processorInvoiceId = metadata.processor_invoice_id;

		// 1. Any payment keeps the pending plan; stop the cron re-picking it
		if (processorInvoiceId) {
			const [invoice] = await repoContext.db
				.select({ status: invoices.status })
				.from(invoices)
				.where(eq(invoices.processor_invoice_id, processorInvoiceId))
				.limit(1);

			if (invoice?.status === InvoiceStatus.Paid) {
				await MetadataService.update({
					db: repoContext.db,
					id: metadata.id,
					updates: { expires_at: null },
				});
				return;
			}
		}

		// 2. Expire the plan it was holding
		await expirePendingCustomerProducts({
			ctx: repoContext,
			metadataId: metadata.id,
		});

		// 3. Release the metadata row
		await MetadataService.delete({ db: repoContext.db, id: metadata.id });
	} catch (error) {
		ctx.logger.error(
			`[expirePendingPlanAtDueDate] Failed for metadata ${metadata.id}; retrying next run: ${error}`,
		);
	}
};
