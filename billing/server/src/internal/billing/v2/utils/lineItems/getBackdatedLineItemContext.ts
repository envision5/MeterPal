import type {
	BillingContext,
	BillingPeriod,
	FullCusProduct,
	LineItemContext,
	Price,
} from "@autumn/shared";
import { getBackdatedImmediatePeriod } from "@/internal/billing/v2/utils/backdate/getBackdatedImmediatePeriod";

type BackdatedLineItemContext = Pick<
	LineItemContext,
	"now" | "effectivePeriod" | "backdate"
>;

export const getBackdatedLineItemContext = ({
	price,
	billingContext,
	billingPeriod,
	direction,
	billingTiming,
}: {
	price: Price;
	billingContext: BillingContext & {
		currentCustomerProduct?: FullCusProduct;
		customerProduct?: FullCusProduct;
	};
	billingPeriod?: BillingPeriod;
	direction: LineItemContext["direction"];
	billingTiming: LineItemContext["billingTiming"];
}): BackdatedLineItemContext | undefined => {
	if (!billingPeriod) return undefined;
	if (billingContext.subscriptionBackdateStartMs === undefined) return undefined;
	// Backdating only applies to a brand-new subscription. An existing one
	// would be prorated by the processor instead.
	const customerProduct =
		billingContext.currentCustomerProduct ?? billingContext.customerProduct;
	if (customerProduct?.subscription_ids?.length) return undefined;
	if (direction !== "charge") return undefined;
	if (billingTiming !== "in_advance") return undefined;

	const period = getBackdatedImmediatePeriod({
		price,
		billingContext,
	});
	if (!period) return undefined;

	return {
		now: billingPeriod.start,
		effectivePeriod: { start: period.start, end: period.end },
		backdate: {
			startsAt: period.start,
			cycleCount: period.cycleCount,
		},
	};
};
