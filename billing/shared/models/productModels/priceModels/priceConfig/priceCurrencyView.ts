import type { PriceCurrencyConfig, UsageTier } from "./usagePriceConfig.js";

export type CurrencyAwarePriceConfig = {
	amount?: number | null;
	usage_tiers?: UsageTier[] | null;
	base_currency?: string | null;
	currencies?: Record<string, PriceCurrencyConfig> | null;
};

const resolveBaseCurrency = ({
	config,
	orgDefault,
}: {
	config: CurrencyAwarePriceConfig;
	orgDefault: string;
}): string => (config.base_currency ?? orgDefault).toLowerCase();

export const isBaseCurrency = ({
	config,
	currency,
	orgDefault,
}: {
	config: CurrencyAwarePriceConfig;
	currency: string;
	orgDefault: string;
}): boolean =>
	currency.toLowerCase() === resolveBaseCurrency({ config, orgDefault });

export const priceConfigForCurrency = ({
	config,
	currency,
	orgDefault,
}: {
	config: CurrencyAwarePriceConfig;
	currency: string;
	orgDefault: string;
}): Pick<PriceCurrencyConfig, "amount" | "usage_tiers"> => {
	if (isBaseCurrency({ config, currency, orgDefault })) {
		return { amount: config.amount, usage_tiers: config.usage_tiers };
	}
	const block = config.currencies?.[currency.toLowerCase()];
	return { amount: block?.amount, usage_tiers: block?.usage_tiers };
};

export const priceAmountsForCurrency = ({
	config,
	currency,
}: {
	config: CurrencyAwarePriceConfig;
	currency?: string | null;
}): Pick<PriceCurrencyConfig, "amount" | "usage_tiers"> => {
	if (!currency) {
		return { amount: config.amount, usage_tiers: config.usage_tiers };
	}
	return priceConfigForCurrency({
		config,
		currency,
		orgDefault: config.base_currency ?? currency,
	});
};

export const priceHasCurrencyAmounts = ({
	config,
	currency,
	orgDefault,
	isFixed,
}: {
	config: CurrencyAwarePriceConfig;
	currency: string;
	orgDefault: string;
	isFixed: boolean;
}): boolean => {
	if (isBaseCurrency({ config, currency, orgDefault })) return true;
	const block = config.currencies?.[currency.toLowerCase()];
	if (!block) return false;
	return isFixed ? block.amount != null : !!block.usage_tiers?.length;
};
