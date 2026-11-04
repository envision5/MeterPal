import { getBackendErr } from "@/utils/genUtils";
import { InfoBox } from "@/views/onboarding2/integrate/components/InfoBox";
import type { UpdateCustomerForm } from "../useUpdateCustomerForm";
import { BillingDetailsFields } from "./BillingDetailsFields";

export const BillingDetailsSection = ({
	form,
	loadError,
}: {
	form: UpdateCustomerForm;
	loadError: unknown;
}) => {
	if (loadError) {
		return (
			<InfoBox variant="error">
				{getBackendErr(loadError, "Couldn't load billing details.")}
			</InfoBox>
		);
	}
	return <BillingDetailsFields form={form} />;
};
