import { useState } from "react";
import {
	type DiscountOption,
	discountOptionMatchesSearch,
} from "@/components/forms/attach-v2/utils/discountOptionUtils";
import { useDebounce } from "@/hooks/useDebounce";

const LOOKUP_DEBOUNCE_MS = 300;

/**
 * Search for a discount picker. Filtering is local over the loaded options.
 */
export const useDiscountSearch = ({
	options,
}: {
	options: DiscountOption[];
}) => {
	const [search, setSearch] = useState("");

	const code = useDebounce({
		value: search,
		delayMs: LOOKUP_DEBOUNCE_MS,
	}).trim();
	const hasLocalMatch = options.some((option) =>
		discountOptionMatchesSearch({ option, search: code }),
	);

	return { options, setSearch, isLookingUp: !hasLocalMatch };
};
