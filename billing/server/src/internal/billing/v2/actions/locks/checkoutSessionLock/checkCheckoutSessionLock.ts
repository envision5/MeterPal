import type { BillingContext, BillingPlan } from "@autumn/shared";
import {
	type CheckoutSessionLockData,
	checkoutSessionLock,
} from "@/external/redis/actions/checkoutSessionLock/checkoutSessionLock.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import type { CreateAutumnCheckoutResult } from "@/internal/billing/v2/common/createAutumnCheckout";
import { hashJson } from "@/utils/hash/hashJson";

/** Same params → reuse the pending session. Different params → release the
 * reservation so the caller can create a fresh processor checkout. */
export const checkCheckoutSessionLock = async <T extends BillingContext>({
	ctx,
	params,
	billingContext,
	billingPlan,
	existingLock,
}: {
	ctx: AutumnContext;
	params: unknown;
	billingContext: T;
	billingPlan: BillingPlan;
	existingLock?: CheckoutSessionLockData | null;
}): Promise<CreateAutumnCheckoutResult<T> | null> => {
	const customerId =
		billingContext.fullCustomer.id ?? billingContext.fullCustomer.internal_id;
	const paramsHash = hashJson({ value: params });
	// Entry-time snapshot wins when present; a null snapshot (e.g. caller passed
	// internal_id, reservation keyed on public id) falls back to the canonical key.
	const lock =
		existingLock ?? (await checkoutSessionLock.get({ ctx, customerId }));
	if (!lock) return null;

	if (lock.paramsHash === paramsHash) {
		ctx.logger.info(
			`Returning cached checkout session for customer ${customerId}`,
		);
		return {
			billingContext,
			billingPlan,
			billingResult: {
				processor: {
					deferred: true,
					checkoutUrl: lock.checkoutSessionUrl,
					checkoutId: lock.checkoutSessionId,
				},
			},
		};
	}

	// The params changed, so the reservation belongs to a superseded checkout.
	// Releasing it lets the caller create a fresh processor checkout.
	await checkoutSessionLock.clearIfOwned({
		ctx,
		customerId,
		checkoutSessionId: lock.checkoutSessionId,
	});

	ctx.logger.info(
		`Released checkout session ${lock.checkoutSessionId} for customer ${customerId} (params changed)`,
	);
	return null;
};
