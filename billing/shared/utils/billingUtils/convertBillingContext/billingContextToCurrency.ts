import type { Customer } from "../../../models/cusModels/cusModels.js";
import type { Organization } from "../../../models/orgModels/orgTable.js";
import { resolveCustomerCurrency } from "../../cusUtils/resolveCustomerCurrency.js";

export const billingContextToCurrency = ({
	org,
	billingContext,
}: {
	org: Organization;
	billingContext: {
		currency?: string;
		fullCustomer: Pick<Customer, "currency">;
	};
}): string =>
	billingContext.currency?.toLowerCase() ||
	resolveCustomerCurrency({
		customer: billingContext.fullCustomer,
		org,
	});
