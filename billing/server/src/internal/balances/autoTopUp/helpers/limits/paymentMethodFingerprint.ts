/**
 * The instrument fingerprint used by the durable circuit breaker. For PayPal
 * auto top-ups this is the vaulted billing agreement token, so re-approving
 * (a new BA id) reads as new payment info while the same declining agreement
 * keeps its suspension.
 */
export const paymentMethodToFingerprint = ({
	paymentMethod,
}: {
	paymentMethod?: string | null;
}): string | undefined => {
	if (!paymentMethod) return undefined;

	return paymentMethod;
};
