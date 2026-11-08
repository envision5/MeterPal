import {
	AttachScenario,
	type AutumnBillingPlan,
	CusProductStatus,
	type customerProducts,
	customerProducts as customerProductsTable,
	findCustomerProductById,
	isCustomerProductRevertingTrial,
	PROCESSOR_LINKED_STATUSES,
} from "@autumn/shared";
import { and, eq, inArray, type InferSelectModel } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { applyPooledBalanceCustomerProductTransitions } from "@/internal/billing/v2/pooledBalances/execute/applyPooledBalanceCustomerProductTransitions";
import { sendBillingUpdatedWebhook } from "@/internal/billing/v2/workflows/sendBillingUpdatedWebhook/sendBillingUpdatedWebhook";
import { billingPlanToSendProductsUpdated } from "@/internal/billing/v2/workflows/sendProductsUpdated/billingPlanToSendProductsUpdated";
import { CusService } from "@/internal/customers/CusService";
import { ACTIVE_STATUSES } from "@/internal/customers/cusProducts/CusProductService";
import { deleteCachedFullCustomer } from "@/internal/customers/cusUtils/fullCustomerCacheUtils/deleteCachedFullCustomer";

/**
 * Handles revert trial expiry inside a transaction: expire the trial
 * cusProduct and unpause the previous one atomically so we never leave a
 * customer without an active plan.
 *
 * Emits `customer.products.updated` for the expired trial and restored
 * previous plan, plus `billing.updated` (tag: `trial_ended`).
 *
 * Returns true if handled, false to fall through to standard expiry.
 */
export const tryProcessRevertExpiry = async ({
	ctx,
	customerProduct,
	customerId,
}: {
	ctx: AutumnContext;
	customerProduct: InferSelectModel<typeof customerProducts>;
	customerId: string;
}): Promise<boolean> => {
	if (!isCustomerProductRevertingTrial(customerProduct)) return false;

	const previousCusProductId = customerProduct.previous_customer_product_id;
	if (!previousCusProductId) {
		console.log(
			`[tryProcessRevertExpiry] No previous_customer_product_id on ${customerProduct.id}, falling back to standard expiry`,
		);
		return false;
	}

	// Snapshot fullCustomer BEFORE the transaction so the webhook payload
	// reflects pre-revert state in `previous_attributes`; the previous
	// (paused) cusProduct must be visible.
	const fullCustomer = await CusService.getFull({
		ctx,
		idOrInternalId: customerId,
		withEntities: true,
		withSubs: true,
		inStatuses: PROCESSOR_LINKED_STATUSES,
	});

	const trialFullCusProduct = findCustomerProductById({
		fullCustomer,
		customerProductId: customerProduct.id,
	});
	const previousFullCusProduct = findCustomerProductById({
		fullCustomer,
		customerProductId: previousCusProductId,
	});

	const now = Date.now();
	// The trial-expire UPDATE is status-guarded and decides the run: exactly
	// one concurrent caller flips the row out of ACTIVE_STATUSES and gets to
	// run the transitions/webhooks below — the loser's predicate re-evaluates
	// after the winner commits and matches nothing. (The Paused guard on the
	// restore already made the un-pause side of the revert one-shot.)
	const { claimed, restoredPreviousCustomerProduct } = await ctx.db.transaction(
		async (tx) => {
			const txDb = tx as unknown as DrizzleCli;

			const expiredRows = await txDb
				.update(customerProductsTable)
				.set({ status: CusProductStatus.Expired, updated_at: now })
				.where(
					and(
						eq(customerProductsTable.id, customerProduct.id),
						inArray(customerProductsTable.status, ACTIVE_STATUSES),
					),
				)
				.returning({ id: customerProductsTable.id });

			if (expiredRows.length === 0) {
				return { claimed: false, restoredPreviousCustomerProduct: false };
			}

			const restoredRows = await txDb
				.update(customerProductsTable)
				.set({ status: CusProductStatus.Active, updated_at: now })
				.where(
					and(
						eq(customerProductsTable.id, previousCusProductId),
						eq(customerProductsTable.status, CusProductStatus.Paused),
					),
				)
				.returning({ id: customerProductsTable.id });

			return { claimed: true, restoredPreviousCustomerProduct: restoredRows.length > 0 };
		},
	);

	if (!claimed) {
		// Another instance already expired this trial — its webhook/transitions
		// ran; nothing left to do here.
		return true;
	}

	if (trialFullCusProduct) {
		await applyPooledBalanceCustomerProductTransitions({
			ctx,
			fullCustomer,
			outgoingCustomerProducts: [trialFullCusProduct],
			incomingCustomerProducts:
				restoredPreviousCustomerProduct && previousFullCusProduct
					? [
							{
								...previousFullCusProduct,
								status: CusProductStatus.Active,
							},
						]
					: [],
			now,
		});
	}

	await deleteCachedFullCustomer({
		ctx,
		customerId,
		source: "productCron:revert",
	});

	// Emit billing.updated webhook (fire-and-forget) describing both the
	// trial expiry and the restored previous plan. Skipped silently if we
	// couldn't resolve either snapshot.
	if (trialFullCusProduct && previousFullCusProduct) {
		const autumnBillingPlan: AutumnBillingPlan = {
			customerId: fullCustomer.id ?? fullCustomer.internal_id,
			insertCustomerProducts: [],
			updateCustomerProducts: [
				{
					customerProduct: trialFullCusProduct,
					updates: { status: CusProductStatus.Expired },
				},
				{
					customerProduct: previousFullCusProduct,
					updates: { status: CusProductStatus.Active },
				},
			],
		};

		await billingPlanToSendProductsUpdated({
			ctx,
			autumnBillingPlan,
			billingContext: { fullCustomer },
			fallbackUpdateScenario: AttachScenario.New,
		});

		void sendBillingUpdatedWebhook({
			ctx,
			autumnBillingPlan,
			originalFullCustomer: fullCustomer,
			tags: ["trial_ended"],
		});
	}

	return true;
};
