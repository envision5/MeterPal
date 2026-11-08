import {
	type CusProductStatus,
	type InsertCustomerProduct,
} from "@autumn/shared";
import type { RepoContext } from "@/db/repoContext.js";
import { CusProductService } from "../CusProductService";

/**
 * Batch update customer products by their IDs.
 * Each update is executed in parallel using Promise.all.
 *
 * `inStatuses` skips rows another request has since moved out of those
 * statuses — pass it for status-transition batches so a duplicate cron or a
 * stale read can't re-run a transition (and its follow-ups) on a row.
 */
export const batchUpdateCustomerProducts = async ({
	ctx,

	updates,
	inStatuses,
}: {
	ctx: RepoContext;

	updates: {
		id: string;
		updates: Partial<InsertCustomerProduct>;
	}[];
	inStatuses?: CusProductStatus[];
}): Promise<void> => {
	if (!updates || updates.length === 0) {
		return;
	}

	const updatePromises = updates.map(({ id, updates: updateData }) => {
		if (Object.keys(updateData ?? {}).length === 0) {
			return Promise.resolve();
		}

		return CusProductService.update({
			ctx,
			cusProductId: id,
			updates: updateData,
			inStatuses,
		});
	});

	await Promise.all(updatePromises);
};
