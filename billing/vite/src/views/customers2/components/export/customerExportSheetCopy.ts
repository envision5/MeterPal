import { CustomerExportKind } from "@autumn/shared";
import { type Icon, UsersIcon } from "@phosphor-icons/react";

export const CUSTOMER_EXPORT_SHEET_COPY: Record<
	CustomerExportKind,
	{
		menuIcon: Icon;
		menuLabel: string;
		title: string;
		description: string;
		scanningLabel?: string;
		runningLabel: string;
		submitLabel: string;
	}
> = {
	[CustomerExportKind.Customers]: {
		menuIcon: UsersIcon,
		menuLabel: "Export customers",
		title: "Export customers",
		description: "Download your customer list as a CSV file.",
		runningLabel: "Exporting customers",
		submitLabel: "Start export",
	},
};
