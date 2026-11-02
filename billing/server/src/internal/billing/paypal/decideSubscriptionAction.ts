/**
 * The decision a PayPal plan switch makes, based on what PayPal says about
 * the customer's subscription.
 *
 * PayPal is the authority here: the customer row only remembers WHICH
 * subscription we last started, and that goes stale (the buyer cancels, the
 * subscription expires, or the row was written by a flow that never reached
 * PayPal).  Deciding from the row alone hands out paid plans for free, or
 * skips a purchase that is still owed.
 */

export type PaypalSubscriptionAction =
	/** PayPal confirms an active subscription on THIS plan — already paid. */
	| { type: "already_paid" }
	/** Active, but on another plan — change the existing subscription. */
	| { type: "revise" }
	/** Waiting for the buyer on THIS plan — send them back to the same link. */
	| { type: "reuse_approval" }
	/** Waiting for the buyer but stale or superseded — cancel, then re-create. */
	| { type: "cancel_and_recreate" }
	/** Nothing usable — create a fresh subscription. */
	| { type: "create" };

/** PayPal reports a not-yet-approved subscription as APPROVAL_PENDING. */
export function isAwaitingPaypalApproval(status: string | undefined): boolean {
	return status === "APPROVAL_PENDING" || status === "CREATED";
}

/** PayPal reports a paid subscription as ACTIVE (APPROVED is the brief window before). */
export function isLivePaypalSubscription(status: string | undefined): boolean {
	return status === "ACTIVE" || status === "APPROVED";
}

export function decidePaypalSubscriptionAction({
	paypalStatus,
	subscriptionPlanId,
	targetPlanId,
	isFresh,
	hasApprovalLink,
}: {
	paypalStatus: string | undefined;
	subscriptionPlanId: string | undefined;
	targetPlanId: string;
	/** How recently PayPal created the subscription (approval links go stale). */
	isFresh: boolean;
	/** Whether PayPal still returns a buyer-approval link on it. */
	hasApprovalLink: boolean;
}): PaypalSubscriptionAction {
	if (isLivePaypalSubscription(paypalStatus)) {
		// The buyer is paying for this exact PayPal plan -> nothing to buy.
		// Otherwise they are paying for another plan -> revise, never a second
		// subscription (that would bill them twice).
		return subscriptionPlanId === targetPlanId
			? { type: "already_paid" }
			: { type: "revise" };
	}

	if (isAwaitingPaypalApproval(paypalStatus)) {
		// Reuse the approval link they already have: a second subscription
		// would sit around approvable, and each approval is a real charge.
		if (isFresh && subscriptionPlanId === targetPlanId && hasApprovalLink) {
			return { type: "reuse_approval" };
		}
		return { type: "cancel_and_recreate" };
	}

	// CANCELLED / SUSPENDED / EXPIRED / unknown / no subscription at all.
	return { type: "create" };
}
