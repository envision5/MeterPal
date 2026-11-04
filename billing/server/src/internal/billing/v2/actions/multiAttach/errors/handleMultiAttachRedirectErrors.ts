import { RecaseError } from "@autumn/shared";

/**
 * Validates that redirect_mode "always" is not used when merging into an existing subscription.
 * If the customer has an existing subscription, they must pass new_billing_subscription: true.
 */
export const handleMultiAttachRedirectErrors = ({
	redirectMode,
	hasExistingSubscription,
}: {
	redirectMode: string;
	hasExistingSubscription: boolean;
}) => {
	if (redirectMode === "always" && hasExistingSubscription) {
		throw new RecaseError({
			message:
				'redirect_mode cannot be "always" if customer has an existing subscription. Pass new_billing_subscription: true to create a new subscription.',
			code: "invalid_redirect_mode",
			statusCode: 400,
		});
	}
};
