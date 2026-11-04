import type { Customer } from "../../models/cusModels/cusModels.js";
import type { Organization } from "../../models/orgModels/orgTable.js";
import { orgToCurrency } from "../orgUtils/convertOrgUtils.js";

// `requested` intentionally outranks a stored currency; enforcing the
// customer's currency lock is the attach guard's job, not this resolver's.
export const resolveCustomerCurrency = ({
	customer,
	org,
	requested,
}: {
	customer?: Pick<Customer, "currency"> | null;
	org: Organization;
	requested?: string | null;
}): string =>
	(requested || customer?.currency || orgToCurrency({ org })).toLowerCase();
