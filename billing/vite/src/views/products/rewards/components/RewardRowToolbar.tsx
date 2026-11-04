import type { Reward } from "@autumn/shared";
import { SmallSpinner, ToolbarButton } from "@autumn/ui";
import { Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@autumn/ui";
import { useRewardsQuery } from "@/hooks/queries/useRewardsQuery";
import { RewardService } from "@/services/products/RewardService";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { getBackendErr } from "@/utils/genUtils";

export const RewardRowToolbar = ({ reward }: { reward: Reward }) => {
	const { refetch } = useRewardsQuery();
	const axiosInstance = useAxiosInstance();
	const [deleteLoading, setDeleteLoading] = useState(false);
	const [dropdownOpen, setDropdownOpen] = useState(false);

	const handleDelete = async () => {
		setDeleteLoading(true);

		try {
			await RewardService.deleteReward({
				axiosInstance,
				internalId: reward.internal_id,
			});
			await refetch();
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to delete coupon"));
		}

		setDeleteLoading(false);
		setDropdownOpen(false);
	};

	return (
		<DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
			<DropdownMenuTrigger asChild>
				<ToolbarButton />
			</DropdownMenuTrigger>
			<DropdownMenuContent className="text-muted-foreground" align="end">
				<DropdownMenuItem
					className="flex items-center"
					onClick={async (e) => {
						e.stopPropagation();
						e.preventDefault();
						await handleDelete();
					}}
				>
					<div className="flex items-center justify-between w-full gap-2">
						Delete
						{deleteLoading ? (
							<SmallSpinner />
						) : (
							<Trash size={12} className="text-tertiary-foreground" />
						)}
					</div>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
