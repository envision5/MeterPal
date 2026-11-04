import {
	THREE_DECIMAL_CURRENCIES,
	minorUnitFactor,
} from "@utils/currencyUtils/currencies.js";
import { Decimal } from "decimal.js";

/**
 * Converts an Autumn amount to a processor integer amount in minor units.
 * Multiplies by the currency's minor-unit factor: 1 (JPY), 100 (USD), 1000 (BHD).
 * Three-decimal currencies must be evenly divisible by ten, so they are rounded
 * to two decimals of precision before scaling.
 */
export const atmnToMinorUnitAmount = ({
	amount,
	currency = "USD",
}: {
	amount: number;
	currency?: string;
}): number => {
	if (THREE_DECIMAL_CURRENCIES.has(currency.toLowerCase())) {
		return new Decimal(amount).mul(100).round().mul(10).toNumber();
	}
	return new Decimal(amount)
		.mul(minorUnitFactor(currency))
		.round()
		.toNumber();
};

/**
 * Converts an Autumn amount to a processor decimal string in minor units.
 * Scales by the currency's minor-unit factor; keeps sub-unit precision, so the
 * divisible-by-ten rule (which only applies to integer amounts) is not enforced.
 */
export const atmnToMinorUnitAmountDecimal = ({
	amount,
	currency = "USD",
	decimalPlaces = 10,
}: {
	amount: number | Decimal;
	currency?: string;
	decimalPlaces?: number;
}): string => {
	const decimal = amount instanceof Decimal ? amount : new Decimal(amount);
	return decimal
		.mul(minorUnitFactor(currency))
		.toDecimalPlaces(decimalPlaces)
		.toString();
};

/**
 * Converts a processor minor-unit amount back to an Autumn amount by dividing out
 * the currency's minor-unit factor (100 cents -> 1.00, 1000 fils -> 1.000).
 */
export const minorUnitToAtmnAmount = ({
	amount,
	currency = "usd",
	decimalPlaces = 10,
	round = true,
}: {
	amount: number;
	currency?: string;
	decimalPlaces?: number;
	round?: boolean;
}): number => {
	const finalAmount = new Decimal(amount)
		.div(minorUnitFactor(currency))
		.toNumber();

	if (round) {
		return new Decimal(finalAmount).toDecimalPlaces(decimalPlaces).toNumber();
	}

	if (decimalPlaces) {
		return new Decimal(finalAmount).toDecimalPlaces(decimalPlaces).toNumber();
	}

	return finalAmount;
};
