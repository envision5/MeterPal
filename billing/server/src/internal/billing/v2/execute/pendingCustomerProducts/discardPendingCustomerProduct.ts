import type {
	DeferredAutumnBillingPlanData,
	FullCusProduct,
} from "@autumn/shared";
import { ErrCode, RecaseError } from "@autumn/shared";
import { checkoutSessionLock } from "@/external/redis/actions/checkoutSessionLock/checkoutSessionLock";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { CusProductService } from "@/internal/customers/cusProducts/CusProductService";
import { MetadataService } from "@/internal/metadata/MetadataService";

export const discardPendingCustomerProduct = async ({
	ctx,
	customerProduct,
}: {
	ctx: AutumnContext;
	customerProduct: FullCusProduct;
}) => {
	const metadataId = customerProduct.metadata_id;

	if (metadataId) {
		const metadata = await MetadataService.get({ db: ctx.db, id: metadataId });

		if (metadata?.processor_checkout_session_id) {
			const deferredData = metadata.data as
				| DeferredAutumnBillingPlanData
				| undefined;
			const lockCustomerId =
				deferredData?.billingContext?.fullCustomer?.id ??
				deferredData?.billingContext?.fullCustomer?.internal_id ??
				customerProduct.internal_customer_id;

			const lock = await checkoutSessionLock.get({
				ctx,
				customerId: lockCustomerId,
			});

			// The lock is only ours while it still points at this checkout session.
			// A newer session owns it, so this plan is stale — but the newer one
			// may be mid-flight, so don't discard underneath it.
			const lockOwnedByThisSession =
				!lock ||
				lock.checkoutSessionId === metadata.processor_checkout_session_id;

			if (lockOwnedByThisSession) {
				await checkoutSessionLock.clearIfOwned({
					ctx,
					customerId: lockCustomerId,
					checkoutSessionId: metadata.processor_checkout_session_id,
				});
			} else {
				// A completed session is about to materialize via webhook; discarding
				// its metadata now would lose the paid plan.
				throw new RecaseError({
					message:
						"A checkout session for this customer was just completed and is still being processed",
					code: ErrCode.LockAlreadyExists,
					statusCode: 423,
				});
			}
		}

		await MetadataService.delete({ db: ctx.db, id: metadataId });
	}

	await CusProductService.expireIfPending({
		ctx,
		cusProductId: customerProduct.id,
	});
};
