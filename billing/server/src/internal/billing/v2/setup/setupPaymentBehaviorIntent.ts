import type {
	BillingContextOverride,
	PaymentBehaviorIntent,
} from "@autumn/shared";

export const setupPaymentBehaviorIntent = ({
	contextOverride,
}: {
	contextOverride?: BillingContextOverride;
}): PaymentBehaviorIntent => {
	if (contextOverride?.paymentBehaviorIntent) {
		return contextOverride.paymentBehaviorIntent;
	}

	return "default_incomplete";
};
