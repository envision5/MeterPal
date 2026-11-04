import { CURRENCY_CODES, currencyDisplayName } from "@autumn/shared";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@autumn/ui";

const CURRENCY_OPTIONS = CURRENCY_CODES.map((code) => ({
	code: code.toUpperCase(),
	currency: currencyDisplayName(code),
}));

export const CurrencySelect = ({
	defaultCurrency,
	setDefaultCurrency,
	className,
	disabled,
}: {
	defaultCurrency: string;
	setDefaultCurrency: (currency: string) => void;
	className?: string;
	disabled?: boolean;
}) => {
	return (
		<SearchableSelect
			value={defaultCurrency}
			onValueChange={(value) => setDefaultCurrency(value.toUpperCase())}
			options={CURRENCY_OPTIONS}
			getOptionValue={(currency) => currency.code}
			getOptionLabel={(currency) => `${currency.currency} - ${currency.code}`}
			searchable
			searchPlaceholder="Search currency..."
			placeholder="Select currency..."
			emptyText="No currency found."
			disabled={disabled}
			triggerClassName={cn("w-full", className)}
		/>
	);
};
