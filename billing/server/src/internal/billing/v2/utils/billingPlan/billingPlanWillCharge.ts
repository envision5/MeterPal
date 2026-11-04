import type { BillingPlan } from "@autumn/shared";

export type ChargeReason = "invoice_created" | "subscription_create";

export type BillingPlanChargeResult =
	| { willCharge: true; reason: ChargeReason }
	| { willCharge: false; reason: null };

/**
 * Determines if a billing plan will result in an immediate charge based on
 * the autumn plan's line items (PayPal captures at approval time; DB-only
 * plans charge nothing).
 */
export const billingPlanWillCharge = ({
	billingPlan,
}: {
	billingPlan: Pick<BillingPlan, "autumn">;
}): BillingPlanChargeResult => {
	const lineItems = billingPlan.autumn.lineItems ?? [];

	if (lineItems.some((item) => item.context.direction === "charge")) {
		return { willCharge: true, reason: "invoice_created" };
	}

	if (
		billingPlan.autumn.insertCustomerProducts?.some(
			(cusProduct) => (cusProduct.subscription_ids?.length ?? 0) > 0,
		)
	) {
		return { willCharge: true, reason: "subscription_create" };
	}

	return { willCharge: false, reason: null };
};

/** Maps charge reasons to human-readable messages */
export const getChargeReasonMessage = (reason: ChargeReason): string => {
	switch (reason) {
		case "subscription_create":
			return "creating a new subscription";
		case "invoice_created":
			return "an invoice will be created";
	}
};
