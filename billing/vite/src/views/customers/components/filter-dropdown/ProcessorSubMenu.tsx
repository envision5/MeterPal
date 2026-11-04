import { CoinVerticalIcon } from "@phosphor-icons/react";
import { useCustomerFilters } from "../../hooks/useCustomerFilters";
import {
	type FilterCheckboxOption,
	FilterCheckboxSubMenu,
	toggleFilterValue,
} from "./FilterCheckboxSubMenu";

export const PROCESSOR_OPTIONS: FilterCheckboxOption[] = [
	{
		value: "paypal",
		label: "PayPal",
		icon: <CoinVerticalIcon size={14} weight="fill" />,
	},
];

export const ProcessorSubMenu = ({ onChange }: { onChange?: () => void }) => {
	const { queryStates, setFilters } = useCustomerFilters();
	const selected = queryStates.processor || [];

	// Selected options stay listed so a filter set before a processor was
	// removed can still be cleared.
	const visibleOptions = PROCESSOR_OPTIONS.filter(
		({ value }) => value === "paypal" || selected.includes(value),
	);

	return (
		<FilterCheckboxSubMenu
			label="Processors"
			options={visibleOptions}
			selected={selected}
			onToggle={(value) => {
				setFilters({ processor: toggleFilterValue(selected, value) });
				onChange?.();
			}}
		/>
	);
};
