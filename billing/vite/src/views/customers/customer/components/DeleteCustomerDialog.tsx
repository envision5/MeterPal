import type { Customer } from "@autumn/shared";
import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@autumn/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { useEnv } from "@/utils/envUtils";
import { navigateTo } from "@/utils/genUtils";

export const DeleteCustomerDialog = ({
	customer,
	open,
	setOpen,
	redirectToCustomersPage: redirect = false,
}: {
	customer: Customer;
	open: boolean;
	setOpen: (open: boolean) => void;
	redirectToCustomersPage?: boolean;
}) => {
	const [loadingStates, setLoadingStates] = useState({
		deleteCustomer: false,
	});
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const axiosInstance = useAxiosInstance();
	const env = useEnv();

	const handleClicked = async () => {
		setLoadingStates({ deleteCustomer: true });

		try {
			await axiosInstance.delete(
				`/v1/customers/${customer.id || customer.internal_id}`,
			);

			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["customers"] }),
				queryClient.invalidateQueries({ queryKey: ["full_customers"] }),
			]);
			setOpen(false);
			toast.success("Customer deleted");
			if (redirect) {
				navigateTo(`/customers`, navigate, env);
			}
		} catch (error) {
			toast.error("Failed to delete customer");
		} finally {
			setLoadingStates({ deleteCustomer: false });
			setOpen(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className="w-md bg-card"
				onClick={(e) => e.stopPropagation()}
			>
				<DialogHeader>
					<DialogTitle>
						Delete customer {customer.name ?? customer.email ?? customer.id}
					</DialogTitle>
				</DialogHeader>

				<div className="mb-2 text-sm">
					<p className="text-muted-foreground">
						Are you sure you want to delete this customer in MeterPal? This action
						cannot be undone.
					</p>
				</div>

				<DialogFooter>
					<div className="flex gap-2">
						<Button
							variant="destructive"
							className="cursor-pointer"
							onClick={() => handleClicked()}
							isLoading={loadingStates.deleteCustomer}
						>
							Delete in MeterPal
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
