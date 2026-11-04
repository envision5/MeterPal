import type { ReactNode } from "react";
import { AdminHover } from "@/components/general/AdminHover";

export type AdminPlanIds = {
	internal_product_id?: string | null;
};

export const AdminPlanIdsTooltip = ({
	children,
	ids,
}: {
	children: ReactNode;
	ids: AdminPlanIds;
}) => {
	const texts = [
		ids.internal_product_id && {
			key: "MeterPal internal id",
			value: ids.internal_product_id,
		},
	].filter(Boolean) as { key: string; value: string }[];

	if (texts.length === 0) return <>{children}</>;

	return <AdminHover texts={texts}>{children}</AdminHover>;
};
