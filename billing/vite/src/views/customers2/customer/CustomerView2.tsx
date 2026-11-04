"use client";

import { AppEnv, CusProductStatus, type FullCusProduct } from "@autumn/shared";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@autumn/ui";
import { ClockIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router";
import { useCusRewardsQuery } from "@/hooks/queries/useCusRewardsQuery";
import { useEntity } from "@/hooks/stores/useSubscriptionStore";
import { cn } from "@/lib/utils";
import { useEnv } from "@/utils/envUtils";
import { pushPage } from "@/utils/genUtils";
import ErrorScreen from "@/views/general/ErrorScreen";
import LoadingScreen from "@/views/general/LoadingScreen";
import { useApprovalSheetFromUrl } from "../../approvals/hooks/useApprovalSheetFromUrl";
import { useCusQuery } from "../../customers/customer/hooks/useCusQuery";
import { useCusReferralQuery } from "../../customers/customer/hooks/useCusReferralQuery";
import { CustomerBillingControlsSection } from "../components/CustomerBillingControlsSection";
import { CustomerPlansSection } from "../components/CustomerPlansSection";
import { CustomerLicensePoolsSection } from "../components/customer-licenses/CustomerLicensePoolsSection";
import { CustomerLicensesSection } from "../components/customer-licenses/CustomerLicensesSection";
import { CustomerFeatureUsageTable } from "../components/table/customer-feature-usage/CustomerFeatureUsageTable";
import { CustomerInvoicesTable } from "../components/table/customer-invoices/CustomerInvoicesTable";
import { CustomerUsageAnalyticsTable } from "../components/table/customer-usage-analytics/CustomerUsageAnalyticsTable";
import { CustomerBreadcrumbs } from "./CustomerBreadcrumbs2";
import { CustomerContext } from "./CustomerContext";
import { CustomerPageDetails } from "./CustomerPageDetails";
import { CustomerPageTitle } from "./CustomerPageTitle";
import { CustomerSheets } from "./CustomerSheets";
import { CustomerHeaderActions } from "./components/CustomerHeaderActions";
import { SelectedEntityDetails } from "./components/SelectedEntityDetails";
import { Workbench } from "./workbench/Workbench";

export default function CustomerView2() {
	const {
		customer,
		testClockFrozenTimeMs,
		isLoading: cusLoading,
	} = useCusQuery();

	useCusReferralQuery();
	useCusRewardsQuery();
	const { entityId, setEntityId } = useEntity();
	useApprovalSheetFromUrl({
		resolveSubscriptionItemId: (planId) =>
			planId
				? customer?.customer_products?.find(
						(product: FullCusProduct) =>
							product.product_id === planId &&
							product.status !== CusProductStatus.Expired,
					)?.id
				: undefined,
	});

	const [isInlineEditorOpen, setIsInlineEditorOpen] = useState(false);

	const env = useEnv();

	if (cusLoading && !customer) return <LoadingScreen />;

	if (!customer) {
		return (
			<ErrorScreen>
				<div className="text-muted-foreground text-sm">Customer not found</div>
				<Link
					className="text-tertiary-foreground text-xs hover:underline"
					to={pushPage({ path: "/customers" })}
				>
					Return
				</Link>
			</ErrorScreen>
		);
	}

	return (
		<CustomerContext.Provider
			value={{
				customer,
				entityId: entityId,
				setEntityId,
				isInlineEditorOpen,
				setIsInlineEditorOpen,
			}}
		>
			<CustomerPageTitle customer={customer} />
			<div className="flex w-full h-full overflow-hidden relative">
				<div className="h-full w-full overflow-hidden absolute inset-0 z-0">
					<div className="flex flex-col overflow-x-hidden overflow-y-auto absolute inset-0 pb-8">
						<div className="flex flex-col gap-4 w-full max-w-[1600px] mx-auto px-4 sm:px-10 pt-4 sm:pt-8">
							<div className="flex flex-col gap-2 w-full">
								<div className="flex flex-col w-full">
									<div className="flex items-center justify-between w-full gap-4">
										<CustomerBreadcrumbs />
										<CustomerHeaderActions />
									</div>
									<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between w-full pt-2 gap-2">
										<div className="flex items-center gap-2 min-w-0">
											<h3
												title={customer.name || customer.email || customer.id}
												className={`text-md font-semibold truncate min-w-0 max-w-full sm:max-w-sm ${
													customer.name
														? "text-foreground"
														: customer.email
															? "text-tertiary-foreground"
															: "text-subtle font-mono font-medium!"
												}`}
											>
												{customer.name || customer.email || customer.id}
											</h3>
											{testClockFrozenTimeMs != null && (
												<TooltipProvider>
													<Tooltip delayDuration={0}>
														<TooltipTrigger asChild>
															<span className="flex shrink-0 items-center justify-center size-5 rounded-md bg-orange-500/15">
																<ClockIcon
																	size={12}
																	weight="bold"
																	className="text-orange-500"
																/>
															</span>
														</TooltipTrigger>
														<TooltipContent>
															Test clock:{" "}
															{new Date(testClockFrozenTimeMs).toLocaleString(
																undefined,
																{
																	month: "short",
																	day: "numeric",
																	year: "numeric",
																	hour: "numeric",
																	minute: "2-digit",
																},
															)}
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											)}
										</div>

										<CustomerPageDetails />
									</div>
								</div>
								<SelectedEntityDetails />
							</div>
							<div className="flex flex-col gap-16 w-full">
								<CustomerPlansSection />
								<CustomerLicensePoolsSection />
								<CustomerLicensesSection />
								<CustomerFeatureUsageTable />
								{!entityId && <CustomerUsageAnalyticsTable />}
								<CustomerBillingControlsSection />
								{!entityId && <CustomerInvoicesTable />}
							</div>
						</div>
					</div>
				</div>

				<CustomerSheets />
				<Workbench />
			</div>
		</CustomerContext.Provider>
	);
}
