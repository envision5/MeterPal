import type { FullCustomer } from "@autumn/shared";
import { IconTooltipButton } from "@autumn/ui";
import { BracketsSquareIcon, UserCircleGearIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { useOrg } from "@/hooks/common/useOrg";
import { getInitialScopeEntityId } from "@/hooks/useSheetScopeEntityId";
import { CusService } from "@/services/customers/CusService";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { getBackendErr } from "@/utils/genUtils";
import { useCusQuery } from "@/views/customers/customer/hooks/useCusQuery";
import { useCustomerObjectQuery } from "../hooks/useCustomerObjectQuery";
import { CustomButtons } from "./CustomButtons";
import { ShowCustomerObjectSheet } from "./ShowCustomerObjectSheet";

export function CustomerHeaderActions() {
	const { customer } = useCusQuery();
	const { org } = useOrg();
	const axiosInstance = useAxiosInstance();
	const { customer_id } = useParams();

	useCustomerObjectQuery({
		customerId: customer_id,
		scopeEntityId: getInitialScopeEntityId(
			customer as FullCustomer | undefined,
		),
		enabled: !!customer,
	});

	const [showObjectOpen, setShowObjectOpen] = useState(false);

	const customButtons = org?.custom_buttons ?? [];

	const billingPortalMutation = useMutation({
		mutationFn: () => {
			if (!customer) throw new Error("Customer not loaded");
			return CusService.createBillingPortalSession({
				axios: axiosInstance,
				customer_id: customer.id || customer.internal_id,
			});
		},
		onSuccess: ({ url }) => window.open(url, "_blank"),
		onError: (error) =>
			toast.error(getBackendErr(error, "Failed to open billing portal")),
	});

	return (
		<div className="flex items-center gap-1">
			<CustomButtons buttons={customButtons} customer={customer} />
			<ShowCustomerObjectSheet
				open={showObjectOpen}
				setOpen={setShowObjectOpen}
			/>
			<IconTooltipButton
				tooltip="Show customer object"
				icon={<BracketsSquareIcon size={14} />}
				onClick={() => setShowObjectOpen(true)}
			/>
			<IconTooltipButton
				tooltip="Open customer portal"
				icon={<UserCircleGearIcon size={14} />}
				onClick={() => billingPortalMutation.mutate()}
				disabled={!customer || billingPortalMutation.isPending}
			/>
		</div>
	);
}
