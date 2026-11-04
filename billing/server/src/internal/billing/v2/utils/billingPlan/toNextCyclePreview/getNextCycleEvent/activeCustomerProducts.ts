import type { FullCusProduct } from "@autumn/shared";
import { isCustomerProductActiveDuringPeriod } from "@/internal/billing/v2/utils/customerProducts/customerProductActivity";
import { SECOND_MS } from "./timeUtils";

/** Mirrors phase overlap logic for a single timestamp window. */
export const getActiveCustomerProductsAt = ({
	customerProducts,
	startsAtMs,
}: {
	customerProducts: FullCusProduct[];
	startsAtMs: number;
}) =>
	customerProducts.filter((customerProduct) =>
		isCustomerProductActiveDuringPeriod({
			customerProduct,
			startMs: startsAtMs,
			endMs: startsAtMs + SECOND_MS,
		}),
	);
