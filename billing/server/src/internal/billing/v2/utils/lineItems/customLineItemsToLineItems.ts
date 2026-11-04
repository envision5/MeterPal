import { generateKsuid } from "@autumn/ksuid";
import type { CustomLineItem, LineItem } from "@autumn/shared";

export const customLineItemsToLineItems = ({
	customLineItems,
	currency,
}: {
	customLineItems: CustomLineItem[];
	currency: string;
}): LineItem[] => {
	return customLineItems.map((item) => ({
		id: generateKsuid({ prefix: "invoice_li_" }),
		amount: item.amount,
		amountAfterDiscounts: item.amount,
		description: item.description,
		discounts: [],
		chargeImmediately: true,
		prorated: false,
		context: {
			price: {} as LineItem["context"]["price"],
			product: { id: "", name: item.description } as LineItem["context"]["product"],
			currency,
			direction: item.amount >= 0 ? "charge" : "refund",
			now: Date.now(),
			billingTiming: "in_advance",
			discountable: false,
		},
	})) satisfies LineItem[];
};
