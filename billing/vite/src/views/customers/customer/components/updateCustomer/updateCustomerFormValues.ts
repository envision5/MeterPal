import type { ApiBillingDetails, Customer } from "@autumn/shared";
import {
	type BillingDetailsFormValues,
	billingDetailsChanges,
	billingDetailsToFormValues,
} from "./billingDetails/billingDetailsFormValues";

export type UpdateCustomerFormValues = {
	id: string;
	name: string;
	email: string;
	fingerprint: string;
	billingDetails: BillingDetailsFormValues;
};

export const customerToFormValues = ({
	customer,
	billingDetails,
}: {
	customer: Customer;
	billingDetails: ApiBillingDetails | null | undefined;
}): UpdateCustomerFormValues => ({
	id: customer.id ?? "",
	name: customer.name ?? "",
	email: customer.email ?? "",
	fingerprint: customer.fingerprint ?? "",
	billingDetails: billingDetailsToFormValues(billingDetails),
});

/** The customer fields this form owns, shaped like the cached page customer. */
export const formValuesToCustomerPatch = (
	values: UpdateCustomerFormValues,
) => ({
	name: values.name || null,
	email: values.email || null,
	fingerprint: values.fingerprint || null,
	...(values.id && { id: values.id }),
});

/** Billing details always belong to the customer being edited. */
export const formValuesToUpdateCustomerBody = ({
	initial,
	values,
}: {
	initial: UpdateCustomerFormValues;
	values: UpdateCustomerFormValues;
}) => {
	const billingDetails = billingDetailsChanges({
		initial: initial.billingDetails,
		current: values.billingDetails,
	});

	return {
		...formValuesToCustomerPatch(values),
		...(billingDetails && { billing_details: billingDetails }),
	};
};
