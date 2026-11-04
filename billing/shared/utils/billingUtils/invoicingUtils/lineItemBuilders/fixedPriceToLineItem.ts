import type { LineItem } from "../../../../models/billingModels/lineItem/lineItem";
import type { LineItemContext } from "../../../../models/billingModels/lineItem/lineItemContext";
import { fixedPriceToDescription } from "../descriptionUtils/fixedPriceToLineDescription";
import { priceToLineAmount } from "../lineItemUtils/priceToLineAmount";
import { buildLineItem } from "./buildLineItem";

/**
 * Creates a line item for a fixed price.
 * Returns positive amount - caller uses lineItemToCredit() for refunds.
 */
export const fixedPriceToLineItem = ({
	currency,
	quantity = 1,
	context,
	includeQuantityInDescription = false,
}: {
	currency?: string;
	quantity?: number;
	context: LineItemContext;
	/** License lines show the quantity like feature-usage lines do. */
	includeQuantityInDescription?: boolean;
}): LineItem => {
	const { price, product } = context;
	const billingCurrency = currency ?? context.currency;

	const amount = priceToLineAmount({
		price,
		multiplier: quantity,
		currency: billingCurrency,
	});
	const description = fixedPriceToDescription({
		price,
		currency,
		context,
		quantity: includeQuantityInDescription ? quantity : undefined,
	});

	// Default discountable to false so Autumn pre-calculates discounts
	// and they are properly stored in the DB (not baked into the amount)
	const updatedContext: LineItemContext = {
		...context,
		discountable: context.discountable,
	};

	return buildLineItem({
		context: updatedContext,
		amount,
		description,
		usage: quantity,
		overage: quantity,
	});
};
